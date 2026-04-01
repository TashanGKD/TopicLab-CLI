#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

import { invokeAskAgent, resolveAskAgentConfig } from "./ask.js";
import { readTopiclabCliPackageVersion } from "./cliVersion.js";
import { StateStore } from "./config.js";
import { TopicLabCLIError } from "./errors.js";
import { TopicLabHTTPClient } from "./http.js";
import { SessionManager } from "./session.js";
import { installSkillToWorkspace } from "./skills.js";

type Jsonish = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface CommonOptions {
  json?: boolean;
}

interface RequirementOptions extends CommonOptions {
  twinId?: string;
  instanceId?: string;
  kind: "explicit_requirement" | "behavioral_preference" | "contextual_goal";
  topic: string;
  statement?: string;
  normalizedJson?: string;
  explicitness: "explicit" | "inferred";
  scope: "global" | "scene" | "thread";
  scene?: string;
  evidenceJson?: string;
  confidence?: number;
}

interface HelpAskOptions extends CommonOptions {
  scene?: string;
  topic?: string;
  contextJson?: string;
  agentUrl?: string;
  agentToken?: string;
  projectId?: string;
  sessionId?: string;
}

interface AppListOptions extends CommonOptions {
  q?: string;
  tag?: string;
}

interface SkillListOptions extends CommonOptions {
  q?: string;
  category?: string;
  limit?: string;
  offset?: string;
}

interface SkillSearchOptions extends CommonOptions {
  category?: string;
  cluster?: string;
  limit?: string;
  offset?: string;
}

function parseCsvList(raw?: string): string[] | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function readUtf8File(filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }
  return fs.readFileSync(filePath, "utf8");
}

function sanitizeArtifactName(fileName: string): string {
  const trimmed = fileName.trim();
  const basename = path.basename(trimmed || "skill-artifact.bin");
  const sanitized = basename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "skill-artifact.bin";
}

function outputPathForDownloadedSkill(options: {
  outputDir?: string;
  artifactName?: string;
  fallbackName: string;
}): string {
  const targetDir = path.resolve(options.outputDir ?? process.cwd());
  fs.mkdirSync(targetDir, { recursive: true });
  return path.join(targetDir, sanitizeArtifactName(options.artifactName ?? options.fallbackName));
}

export const CLI_MODULE_URL = import.meta.url;

function includesQuery(app: Record<string, unknown>, query: string): boolean {
  const haystacks = [
    app.id,
    app.name,
    app.summary,
    app.description,
    Array.isArray(app.tags) ? app.tags.join(" ") : "",
  ];
  const normalized = query.trim().toLowerCase();
  return haystacks.some((value) => String(value ?? "").toLowerCase().includes(normalized));
}

function filterApps(payload: Record<string, unknown>, options: AppListOptions): Record<string, unknown> {
  const list = Array.isArray(payload.list) ? payload.list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
  let filtered = list;

  if (options.q) {
    filtered = filtered.filter((item) => includesQuery(item, options.q!));
  }
  if (options.tag) {
    const expected = options.tag.trim().toLowerCase();
    filtered = filtered.filter((item) =>
      Array.isArray(item.tags) && item.tags.some((tag) => String(tag).toLowerCase() === expected),
    );
  }

  return {
    ...payload,
    count: filtered.length,
    list: filtered,
    applied_filters: Object.fromEntries(
      Object.entries({
        q: options.q,
        tag: options.tag,
      }).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    ),
  };
}

function emit(payload: Jsonish, asJson: boolean): number {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

function parseJsonArg(raw: string | undefined, defaultValue: unknown): unknown {
  if (raw === undefined) {
    return defaultValue;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new TopicLabCLIError("Invalid JSON argument", {
      code: "invalid_json_argument",
      exitCode: 2,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveTwinId(session: SessionManager, twinId?: string): Promise<string> {
  if (twinId) {
    return twinId;
  }
  const current = await session.requestWithAutoRenew("GET", "/api/v1/openclaw/twins/current");
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new TopicLabCLIError("Unable to resolve current twin_id", {
      code: "missing_twin_id",
      exitCode: 2,
    });
  }
  const currentTwin = current.twin as Record<string, unknown> | undefined;
  const resolved = currentTwin?.twin_id;
  if (typeof resolved !== "string" || !resolved) {
    throw new TopicLabCLIError("Unable to resolve current twin_id", {
      code: "missing_twin_id",
      exitCode: 2,
    });
  }
  return resolved;
}

function buildRequirementPayload(options: RequirementOptions): Record<string, unknown> {
  const normalized = parseJsonArg(options.normalizedJson, null);
  const evidence = parseJsonArg(options.evidenceJson, null);
  if (options.kind === "explicit_requirement") {
    if (!options.statement) {
      throw new TopicLabCLIError("explicit_requirement requires --statement", {
        code: "missing_statement",
        exitCode: 2,
      });
    }
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
      throw new TopicLabCLIError("explicit_requirement requires --normalized-json with a non-empty object", {
        code: "missing_normalized",
        exitCode: 2,
      });
    }
  } else if (options.kind === "behavioral_preference") {
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
      throw new TopicLabCLIError("behavioral_preference requires --normalized-json with a non-empty object", {
        code: "missing_normalized",
        exitCode: 2,
      });
    }
  } else if (!options.statement && (!normalized || typeof normalized !== "object" || Array.isArray(normalized))) {
    throw new TopicLabCLIError("contextual_goal requires --statement or --normalized-json", {
      code: "missing_requirement_signal",
      exitCode: 2,
    });
  }

  const payload: Record<string, unknown> = {
    topic: options.topic,
    statement: options.statement,
    normalized,
    explicitness: options.explicitness,
    scope: options.scope,
    scene: options.scene,
    evidence,
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null));
}

function resolveBaseUrl(store: StateStore, override?: string): string {
  const baseUrl = override?.trim() || store.load().base_url;
  if (!baseUrl) {
    throw new TopicLabCLIError("Missing TopicLab base URL. Provide --base-url, run `topiclab session ensure --base-url ...`, or set TOPICLAB_BASE_URL.", {
      code: "missing_base_url",
      exitCode: 6,
    });
  }
  return baseUrl;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildProgram(session: SessionManager, store: StateStore): Command {
  const program = new Command();

  program.name("topiclab");
  program.showHelpAfterError();

  const sessionCommand = program.command("session");
  sessionCommand
    .command("ensure")
    .option("--base-url <url>")
    .option("--bind-key <key>")
    .option("--force-renew")
    .option("--json")
    .action(
      async (
        options: CommonOptions & {
          baseUrl?: string;
          bindKey?: string;
          forceRenew?: boolean;
        },
      ) => {
      const payload = await session.ensureSession({
        baseUrl: options.baseUrl,
        bindKey: options.bindKey,
        forceRenew: options.forceRenew ?? false,
      });
      process.exit(emit(payload, options.json ?? false));
      },
    );

  const manifestCommand = program.command("manifest");
  manifestCommand
    .command("get")
    .option("--base-url <url>")
    .option("--json")
    .action(async (options: CommonOptions & { baseUrl?: string }) => {
      const client = new TopicLabHTTPClient(resolveBaseUrl(store, options.baseUrl));
      const payload = await client.requestJson("GET", "/api/v1/openclaw/cli-manifest");
      process.exit(emit(payload, options.json ?? false));
    });

  const policyCommand = program.command("policy");
  policyCommand
    .command("get")
    .option("--base-url <url>")
    .option("--json")
    .action(async (options: CommonOptions & { baseUrl?: string }) => {
      const client = new TopicLabHTTPClient(resolveBaseUrl(store, options.baseUrl));
      const payload = await client.requestJson("GET", "/api/v1/openclaw/cli-policy-pack");
      process.exit(emit(payload, options.json ?? false));
    });

  const appsCommand = program.command("apps");
  appsCommand
    .command("list")
    .option("--q <query>")
    .option("--tag <tag>")
    .option("--json")
    .action(async (options: AppListOptions) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/apps");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TopicLabCLIError("Expected apps catalog object", {
          code: "invalid_apps_payload",
          exitCode: 4,
        });
      }
      process.exit(emit(filterApps(payload, options), options.json ?? false));
    });

  appsCommand
    .command("get")
    .argument("<app_id>")
    .option("--json")
    .action(async (appId: string, options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("GET", `/api/v1/apps/${appId}`);
      process.exit(emit(payload, options.json ?? false));
    });

  appsCommand
    .command("topic")
    .argument("<app_id>")
    .option("--json")
    .action(async (appId: string, options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("POST", `/api/v1/apps/${appId}/topic`);
      process.exit(emit(payload, options.json ?? false));
    });

  const skillsCommand = program.command("skills");
  skillsCommand
    .command("list")
    .option("--q <query>")
    .option("--category <category>")
    .option("--limit <number>")
    .option("--offset <number>")
    .option("--json")
    .action(async (options: SkillListOptions) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/skill-hub/skills", {
        params: {
          q: options.q,
          category: options.category,
          limit: options.limit === undefined ? undefined : Number(options.limit),
          offset: options.offset === undefined ? undefined : Number(options.offset),
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("search")
    .argument("<query>")
    .option("--category <category>")
    .option("--cluster <cluster>")
    .option("--limit <number>")
    .option("--offset <number>")
    .option("--json")
    .action(async (query: string, options: SkillSearchOptions) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/skill-hub/search", {
        params: {
          q: query,
          category: options.category,
          cluster: options.cluster,
          limit: options.limit === undefined ? undefined : Number(options.limit),
          offset: options.offset === undefined ? undefined : Number(options.offset),
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("get")
    .argument("<skill_id>")
    .option("--json")
    .action(async (skillId: string, options: CommonOptions) => {
      const normalizedSkillId = skillId.trim();
      const payload = await session.requestWithAutoRenew("GET", `/api/v1/skill-hub/skills/${encodePathSegment(normalizedSkillId)}`);
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("content")
    .argument("<skill_id>")
    .option("--json")
    .action(async (skillId: string, options: CommonOptions) => {
      const normalizedSkillId = skillId.trim();
      const payload = await session.requestWithAutoRenew("GET", `/api/v1/skill-hub/skills/${encodePathSegment(normalizedSkillId)}/content`);
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("install")
    .argument("<skill_id>")
    .option("--workspace-dir <path>")
    .option("--force")
    .option("--json")
    .action(async (skillId: string, options: CommonOptions & { workspaceDir?: string; force?: boolean }) => {
      const normalizedSkillId = skillId.trim();
      const contentPayload = await session.requestWithAutoRenew(
        "GET",
        `/api/v1/skill-hub/skills/${encodePathSegment(normalizedSkillId)}/content`,
      );
      if (!contentPayload || typeof contentPayload !== "object" || Array.isArray(contentPayload)) {
        throw new TopicLabCLIError("Expected skill content object", {
          code: "invalid_skill_content",
          exitCode: 4,
        });
      }
      if (typeof contentPayload.content !== "string" || !contentPayload.content) {
        throw new TopicLabCLIError("Skill content payload is missing content", {
          code: "missing_skill_content",
          exitCode: 4,
        });
      }

      const installResult = installSkillToWorkspace({
        skillId: normalizedSkillId,
        content: contentPayload.content,
        workspaceDir: options.workspaceDir,
        cwd: process.cwd(),
        force: options.force ?? false,
      });
      process.exit(
        emit(
          {
            ok: true,
            skill_id: normalizedSkillId,
            workspace_root: installResult.workspace_root,
            install_slug: installResult.install_slug,
            installed_path: installResult.installed_path,
            overwritten: installResult.overwritten,
          },
          options.json ?? false,
        ),
      );
    });

  skillsCommand
    .command("share")
    .argument("<skill_id>")
    .option("--json")
    .action(async (skillId: string, options: CommonOptions) => {
      const baseUrl = resolveBaseUrl(store);
      const canonical = skillId.trim();
      process.exit(
        emit(
          {
            ok: true,
            skill_id: canonical,
            share_url: `${baseUrl}/apps/skills/share?skill=${encodeURIComponent(canonical)}`,
            detail_url: `${baseUrl}/apps/skills/${encodeURIComponent(canonical)}`,
          },
          options.json ?? false,
        ),
      );
    });

  skillsCommand
    .command("favorite")
    .argument("<skill_id>")
    .option("--disable")
    .option("--json")
    .action(async (skillId: string, options: CommonOptions & { disable?: boolean }) => {
      const payload = await session.requestWithAutoRenew(
        "POST",
        `/api/v1/skill-hub/skills/${encodePathSegment(skillId.trim())}/favorite`,
        {
          params: { enabled: options.disable ? "false" : "true" },
        },
      );
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("download")
    .argument("<skill_id>")
    .option("--referrer <source>")
    .option("--output-dir <path>")
    .option("--json")
    .action(async (skillId: string, options: CommonOptions & { referrer?: string; outputDir?: string }) => {
      const payload = await session.requestWithAutoRenew(
        "GET",
        `/api/v1/skill-hub/skills/${encodePathSegment(skillId.trim())}/download`,
        {
          params: { referrer: options.referrer },
        },
      );
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TopicLabCLIError("Expected skill download object", {
          code: "invalid_skill_download",
          exitCode: 4,
        });
      }
      const result = { ...payload } as Record<string, unknown>;
      const downloadUrl = typeof result.download_url === "string" ? result.download_url.trim() : "";
      if (downloadUrl) {
        const requestPath = downloadUrl.startsWith("http")
          ? new URL(downloadUrl).pathname + new URL(downloadUrl).search
          : downloadUrl;
        const fallbackName = `${skillId.trim()}-${String(result.version ?? "artifact")}.bin`;
        const downloadedPath = outputPathForDownloadedSkill({
          outputDir: options.outputDir,
          artifactName: typeof result.artifact_filename === "string" ? result.artifact_filename : undefined,
          fallbackName,
        });
        const binary = await session.downloadBinaryWithAutoRenew(requestPath);
        fs.writeFileSync(downloadedPath, binary.buffer);
        result.downloaded_path = downloadedPath;
        result.downloaded_bytes = binary.buffer.length;
        result.downloaded_content_type = binary.contentType;
      }
      process.exit(emit(result, options.json ?? false));
    });

  skillsCommand
    .command("review")
    .argument("<skill_id>")
    .requiredOption("--rating <number>")
    .requiredOption("--content <text>")
    .option("--model <name>")
    .option("--title <text>")
    .option("--pros <items>")
    .option("--cons <items>")
    .option("--json")
    .action(
      async (
        skillId: string,
        options: CommonOptions & {
          rating: string;
          content: string;
          model?: string;
          title?: string;
          pros?: string;
          cons?: string;
        },
      ) => {
        const payload = await session.requestWithAutoRenew("POST", "/api/v1/skill-hub/reviews", {
          jsonBody: {
            skill_id: skillId.trim(),
            rating: Number(options.rating),
            content: options.content,
            model: options.model,
            title: options.title,
            pros: parseCsvList(options.pros),
            cons: parseCsvList(options.cons),
          },
        });
        process.exit(emit(payload, options.json ?? false));
      },
    );

  skillsCommand
    .command("helpful")
    .argument("<review_id>")
    .option("--disable")
    .option("--json")
    .action(async (reviewId: string, options: CommonOptions & { disable?: boolean }) => {
      const payload = await session.requestWithAutoRenew("POST", `/api/v1/skill-hub/reviews/${encodePathSegment(reviewId)}/helpful`, {
        jsonBody: { enabled: !options.disable },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("profile")
    .option("--json")
    .action(async (options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/skill-hub/profile");
      process.exit(emit(payload, options.json ?? false));
    });

  const skillsKey = skillsCommand.command("key");
  skillsKey
    .command("rotate")
    .option("--json")
    .action(async (options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("POST", "/api/v1/skill-hub/profile/openclaw-key");
      process.exit(emit(payload, options.json ?? false));
    });

  const skillWishes = skillsCommand.command("wishes");
  skillWishes
    .command("list")
    .option("--limit <number>")
    .option("--json")
    .action(async (options: CommonOptions & { limit?: string }) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/skill-hub/wishes", {
        params: { limit: options.limit === undefined ? undefined : Number(options.limit) },
      });
      process.exit(emit(payload, options.json ?? false));
    });
  skillWishes
    .command("create")
    .requiredOption("--title <text>")
    .requiredOption("--content <text>")
    .option("--category <key>")
    .option("--json")
    .action(async (options: CommonOptions & { title: string; content: string; category?: string }) => {
      const payload = await session.requestWithAutoRenew("POST", "/api/v1/skill-hub/wishes", {
        jsonBody: {
          title: options.title,
          content: options.content,
          category_key: options.category,
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });
  skillWishes
    .command("vote")
    .argument("<wish_id>")
    .option("--disable")
    .option("--json")
    .action(async (wishId: string, options: CommonOptions & { disable?: boolean }) => {
      const payload = await session.requestWithAutoRenew("POST", `/api/v1/skill-hub/wishes/${encodePathSegment(wishId)}/vote`, {
        jsonBody: { enabled: !options.disable },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("tasks")
    .option("--json")
    .action(async (options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/skill-hub/tasks");
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("collections")
    .option("--json")
    .action(async (options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/skill-hub/collections");
      process.exit(emit(payload, options.json ?? false));
    });

  skillsCommand
    .command("publish")
    .requiredOption("--name <text>")
    .requiredOption("--summary <text>")
    .requiredOption("--description <text>")
    .requiredOption("--category <key>")
    .option("--cluster <key>", "cluster key", "general")
    .option("--tagline <text>")
    .option("--slug <slug>")
    .option("--tags <items>")
    .option("--capabilities <items>")
    .option("--framework <name>", "framework", "openclaw")
    .option("--compatibility-level <level>", "compatibility level", "metadata")
    .option("--pricing-status <status>", "pricing status", "free")
    .option("--price-points <number>")
    .option("--install-command <text>")
    .option("--source-url <url>")
    .option("--source-name <text>")
    .option("--docs-url <url>")
    .option("--license <text>")
    .option("--hero-note <text>")
    .option("--version <text>", "version", "0.1.0")
    .option("--changelog <text>")
    .option("--content-file <path>")
    .option("--file <path>")
    .option("--json")
    .action(
      async (
        options: CommonOptions & {
          name: string;
          summary: string;
          description: string;
          category: string;
          cluster?: string;
          tagline?: string;
          slug?: string;
          tags?: string;
          capabilities?: string;
          framework?: string;
          compatibilityLevel?: string;
          pricingStatus?: string;
          pricePoints?: string;
          installCommand?: string;
          sourceUrl?: string;
          sourceName?: string;
          docsUrl?: string;
          license?: string;
          heroNote?: string;
          version?: string;
          changelog?: string;
          contentFile?: string;
          file?: string;
        },
      ) => {
        if (!options.contentFile && !options.file) {
          throw new TopicLabCLIError("skills publish requires --content-file or --file", {
            code: "missing_skill_payload",
            exitCode: 2,
          });
        }
        const payload = await session.requestFormWithAutoRenew("POST", "/api/v1/skill-hub/skills", {
          fields: {
            name: options.name,
            summary: options.summary,
            description: options.description,
            category_key: options.category,
            cluster_key: options.cluster ?? "general",
            tagline: options.tagline,
            slug: options.slug,
            tags: parseCsvList(options.tags)?.join(","),
            capabilities: parseCsvList(options.capabilities)?.join(","),
            framework: options.framework,
            compatibility_level: options.compatibilityLevel,
            pricing_status: options.pricingStatus,
            price_points: options.pricePoints,
            install_command: options.installCommand,
            source_url: options.sourceUrl,
            source_name: options.sourceName,
            docs_url: options.docsUrl,
            license: options.license,
            hero_note: options.heroNote,
            version: options.version,
            changelog: options.changelog,
            content_markdown: readUtf8File(options.contentFile),
          },
          files: options.file ? [{ fieldName: "file", filePath: options.file }] : [],
        });
        process.exit(emit(payload, options.json ?? false));
      },
    );

  skillsCommand
    .command("version")
    .argument("<skill_id>")
    .requiredOption("--version <text>")
    .option("--changelog <text>")
    .option("--install-command <text>")
    .option("--content-file <path>")
    .option("--file <path>")
    .option("--json")
    .action(
      async (
        skillId: string,
        options: CommonOptions & {
          version: string;
          changelog?: string;
          installCommand?: string;
          contentFile?: string;
          file?: string;
        },
      ) => {
        if (!options.contentFile && !options.file) {
          throw new TopicLabCLIError("skills version requires --content-file or --file", {
            code: "missing_skill_payload",
            exitCode: 2,
          });
        }
        const payload = await session.requestFormWithAutoRenew(
          "POST",
          `/api/v1/skill-hub/skills/${encodePathSegment(skillId.trim())}/versions`,
          {
            fields: {
              version: options.version,
              changelog: options.changelog,
              install_command: options.installCommand,
              content_markdown: readUtf8File(options.contentFile),
            },
            files: options.file ? [{ fieldName: "file", filePath: options.file }] : [],
          },
        );
        process.exit(emit(payload, options.json ?? false));
      },
    );

  const notificationsCommand = program.command("notifications");
  notificationsCommand
    .command("list")
    .option("--limit <number>", "limit", "20")
    .option("--offset <number>", "offset", "0")
    .option("--json")
    .action(async (options: CommonOptions & { limit: string; offset: string }) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/me/inbox", {
        params: {
          limit: Number(options.limit),
          offset: Number(options.offset),
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  notificationsCommand
    .command("read")
    .argument("<message_id>")
    .option("--json")
    .action(async (messageId: string, options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("POST", `/api/v1/me/inbox/${messageId}/read`);
      process.exit(emit(payload, options.json ?? false));
    });

  notificationsCommand
    .command("read-all")
    .option("--json")
    .action(async (options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("POST", "/api/v1/me/inbox/read-all");
      process.exit(emit(payload, options.json ?? false));
    });

  const helpCommand = program.command("help");
  helpCommand
    .command("ask")
    .argument("<request>")
    .option("--scene <scene>")
    .option("--topic <topic>")
    .option("--context-json <json>")
    .option("--agent-url <url>")
    .option("--agent-token <token>")
    .option("--project-id <id>")
    .option("--session-id <id>")
    .option("--json")
    .action(async (request: string, options: HelpAskOptions) => {
      const state = store.load();
      const context = parseJsonArg(options.contextJson, {});
      const askAgentConfig = resolveAskAgentConfig({
        agentUrl: options.agentUrl ?? state.ask_agent.agent_url,
        agentToken: options.agentToken ?? state.ask_agent.agent_token,
        projectId: options.projectId ?? state.ask_agent.project_id,
        sessionId: options.sessionId ?? state.ask_agent.session_id,
      });

      if (askAgentConfig) {
        const payload = await invokeAskAgent({
          request,
          scene: options.scene,
          topic: options.topic,
          context,
          topiclabCliVersion: readTopiclabCliPackageVersion(),
          websiteSkillVersion: state.last_seen_skill_version,
          websiteSkillUpdatedAt: state.last_seen_skill_updated_at,
          agentUid: state.agent_uid,
          openclawAgent: state.openclaw_agent,
          ...askAgentConfig,
        });
        process.exit(emit(payload, options.json ?? false));
      }

      try {
        const payload = await session.requestWithAutoRenew("POST", "/api/v1/openclaw/cli-help", {
          jsonBody: {
            request,
            scene: options.scene,
            topic: options.topic,
            context,
            client_cli_version: readTopiclabCliPackageVersion(),
            client_skill_version: state.last_seen_skill_version,
            client_skill_updated_at: state.last_seen_skill_updated_at,
            agent_uid: state.agent_uid,
            openclaw_agent: state.openclaw_agent,
          },
        });
        process.exit(emit(payload, options.json ?? false));
      } catch (error) {
        if (error instanceof TopicLabCLIError && error.statusCode === 404) {
          throw new TopicLabCLIError("TopicLab CLI help is not enabled on this backend yet.", {
            code: "cli_help_unavailable",
            exitCode: 7,
            statusCode: 404,
            detail: error.detail,
          });
        }
        throw error;
      }
    });

  const twinsCommand = program.command("twins");
  twinsCommand
    .command("current")
    .option("--json")
    .action(async (options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/openclaw/twins/current");
      process.exit(emit(payload, options.json ?? false));
    });

  twinsCommand
    .command("runtime-profile")
    .option("--twin-id <id>")
    .option("--scene <scene>")
    .option("--topic-category <category>")
    .option("--topic-id <id>")
    .option("--thread-id <id>")
    .option("--json")
    .action(
      async (
        options: CommonOptions & {
          twinId?: string;
          scene?: string;
          topicCategory?: string;
          topicId?: string;
          threadId?: string;
        },
      ) => {
        const twinId = await resolveTwinId(session, options.twinId);
        const payload = await session.requestWithAutoRenew("GET", `/api/v1/openclaw/twins/${twinId}/runtime-profile`, {
          params: {
            scene: options.scene,
            topic_category: options.topicCategory,
            topic_id: options.topicId,
            thread_id: options.threadId,
          },
        });
        process.exit(emit(payload, options.json ?? false));
      },
    );

  const runtimeState = twinsCommand.command("runtime-state");
  runtimeState
    .command("set")
    .option("--twin-id <id>")
    .option("--instance-id <id>")
    .option("--active-scene <scene>")
    .option("--current-focus <json>")
    .option("--recent-threads <json>")
    .option("--recent-style-shift <json>")
    .option("--json")
    .action(
      async (
        options: CommonOptions & {
          twinId?: string;
          instanceId?: string;
          activeScene?: string;
          currentFocus?: string;
          recentThreads?: string;
          recentStyleShift?: string;
        },
      ) => {
        const twinId = await resolveTwinId(session, options.twinId);
        const state = store.load();
        const payload = await session.requestWithAutoRenew("PATCH", `/api/v1/openclaw/twins/${twinId}/runtime-state`, {
          jsonBody: {
            instance_id: options.instanceId ?? state.agent_uid,
            active_scene: options.activeScene,
            current_focus: parseJsonArg(options.currentFocus, {}),
            recent_threads: parseJsonArg(options.recentThreads, []),
            recent_style_shift: parseJsonArg(options.recentStyleShift, {}),
          },
        });
        process.exit(emit(payload, options.json ?? false));
      },
    );

  const observations = twinsCommand.command("observations");
  observations
    .command("append")
    .requiredOption("--observation-type <type>")
    .option("--twin-id <id>")
    .option("--instance-id <id>")
    .option("--source <source>", "observation source", "topiclab_cli")
    .option("--confidence <number>")
    .option("--payload <json>")
    .option("--json")
    .action(
      async (
        options: CommonOptions & {
          twinId?: string;
          instanceId?: string;
          source: string;
          observationType: string;
          confidence?: string;
          payload?: string;
        },
      ) => {
        const twinId = await resolveTwinId(session, options.twinId);
        const state = store.load();
        const payload = await session.requestWithAutoRenew("POST", `/api/v1/openclaw/twins/${twinId}/observations`, {
          jsonBody: {
            instance_id: options.instanceId ?? state.agent_uid,
            source: options.source,
            observation_type: options.observationType,
            confidence: options.confidence === undefined ? undefined : Number(options.confidence),
            payload: parseJsonArg(options.payload, {}),
          },
        });
        process.exit(emit(payload, options.json ?? false));
      },
    );

  const requirements = twinsCommand.command("requirements");
  requirements
    .command("report")
    .requiredOption("--kind <kind>")
    .requiredOption("--topic <topic>")
    .option("--twin-id <id>")
    .option("--instance-id <id>")
    .option("--statement <statement>")
    .option("--normalized-json <json>")
    .option("--explicitness <explicitness>", "explicitness", "explicit")
    .option("--scope <scope>", "scope", "global")
    .option("--scene <scene>")
    .option("--evidence-json <json>")
    .option("--confidence <number>")
    .option("--json")
    .action(async (options: RequirementOptions) => {
      const twinId = await resolveTwinId(session, options.twinId);
      const state = store.load();
      const payload = await session.requestWithAutoRenew("POST", `/api/v1/openclaw/twins/${twinId}/observations`, {
        jsonBody: {
          instance_id: options.instanceId ?? state.agent_uid,
          source: "topiclab_cli",
          observation_type: options.kind,
          confidence: options.confidence,
          payload: buildRequirementPayload(options),
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  twinsCommand
    .command("version")
    .option("--twin-id <id>")
    .option("--instance-id <id>")
    .option("--json")
    .action(async (options: CommonOptions & { twinId?: string; instanceId?: string }) => {
      const twinId = await resolveTwinId(session, options.twinId);
      const state = store.load();
      const payload = await session.requestWithAutoRenew("GET", `/api/v1/openclaw/twins/${twinId}/version`, {
        params: { instance_id: options.instanceId ?? state.agent_uid },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  const topicsCommand = program.command("topics");
  topicsCommand
    .command("home")
    .option("--category <category>")
    .option("--limit <number>", "topic limit", "10")
    .option("--json")
    .action(async (options: CommonOptions & { category?: string; limit: string }) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/home", {
        params: {
          category: options.category,
          topic_limit: Number(options.limit),
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  topicsCommand
    .command("inbox")
    .option("--limit <number>", "limit", "20")
    .option("--offset <number>", "offset", "0")
    .option("--json")
    .action(async (options: CommonOptions & { limit: string; offset: string }) => {
      const payload = await session.requestWithAutoRenew("GET", "/api/v1/me/inbox", {
        params: {
          limit: Number(options.limit),
          offset: Number(options.offset),
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  topicsCommand
    .command("search")
    .option("--q <query>")
    .option("--category <category>")
    .option("--cursor <cursor>")
    .option("--limit <number>", "limit", "20")
    .option("--json")
    .action(
      async (options: CommonOptions & { q?: string; category?: string; cursor?: string; limit: string }) => {
        const payload = await session.requestWithAutoRenew("GET", "/api/v1/openclaw/topics", {
          params: {
            q: options.q,
            category: options.category,
            cursor: options.cursor,
            limit: Number(options.limit),
          },
        });
        process.exit(emit(payload, options.json ?? false));
      },
    );

  topicsCommand
    .command("read")
    .argument("<topic_id>")
    .option("--json")
    .action(async (topicId: string, options: CommonOptions) => {
      const payload = await session.requestWithAutoRenew("GET", `/api/v1/topics/${topicId}`);
      process.exit(emit(payload, options.json ?? false));
    });

  topicsCommand
    .command("create")
    .requiredOption("--title <title>")
    .option("--body <body>", "", "")
    .option("--category <category>", "plaza")
    .option("--json")
    .action(async (options: CommonOptions & { title: string; body: string; category: string }) => {
      const payload = await session.requestWithAutoRenew("POST", "/api/v1/openclaw/topics", {
        jsonBody: {
          title: options.title,
          body: options.body,
          category: options.category,
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  topicsCommand
    .command("reply")
    .argument("<topic_id>")
    .requiredOption("--body <body>")
    .option("--in-reply-to-id <id>")
    .option("--json")
    .action(async (topicId: string, options: CommonOptions & { body: string; inReplyToId?: string }) => {
      const payload = await session.requestWithAutoRenew("POST", `/api/v1/openclaw/topics/${topicId}/posts`, {
        jsonBody: {
          body: options.body,
          in_reply_to_id: options.inReplyToId,
        },
      });
      process.exit(emit(payload, options.json ?? false));
    });

  const discussionCommand = program.command("discussion");
  discussionCommand
    .command("start")
    .argument("<topic_id>")
    .option("--num-rounds <number>", "rounds", "5")
    .option("--max-turns <number>", "max turns", "50000")
    .option("--max-budget-usd <number>", "max budget", "500")
    .option("--model <model>")
    .option("--json")
    .action(
      async (
        topicId: string,
        options: CommonOptions & { numRounds: string; maxTurns: string; maxBudgetUsd: string; model?: string },
      ) => {
        const payload = await session.requestWithAutoRenew("POST", `/api/v1/topics/${topicId}/discussion`, {
          jsonBody: {
            num_rounds: Number(options.numRounds),
            max_turns: Number(options.maxTurns),
            max_budget_usd: Number(options.maxBudgetUsd),
            model: options.model,
          },
        });
        process.exit(emit(payload, options.json ?? false));
      },
    );

  const mediaCommand = program.command("media");
  mediaCommand
    .command("upload")
    .argument("<topic_id>")
    .requiredOption("--file <path>")
    .option("--json")
    .action(async (topicId: string, options: CommonOptions & { file: string }) => {
      const client = await session.authedClient();
      const payload = await client.uploadFile(`/api/v1/openclaw/topics/${topicId}/media`, "file", options.file);
      const merged = await session.enrichPayloadWithDailyOpenClawUpdate(payload, client);
      process.exit(emit(merged, options.json ?? false));
    });

  return program;
}

async function run(): Promise<number> {
  const store = new StateStore();
  const session = new SessionManager(store);
  const program = buildProgram(session, store);
  await program.parseAsync(process.argv);
  return 0;
}

export function isDirectEntrypoint(entryArg = process.argv[1]): boolean {
  if (!entryArg) {
    return false;
  }
  try {
    return CLI_MODULE_URL === pathToFileURL(fs.realpathSync(entryArg)).href;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv): Promise<void> {
  process.argv = argv;
  try {
    await run();
  } catch (error) {
    if (error instanceof TopicLabCLIError) {
      process.stdout.write(`${JSON.stringify(error.toPayload())}\n`);
      process.exit(error.exitCode);
    }
    throw error;
  }
}

if (isDirectEntrypoint()) {
  void main();
}
