#!/usr/bin/env node

import { Command } from "commander";

import { StateStore } from "./config.js";
import { TopicLabCLIError } from "./errors.js";
import { TopicLabHTTPClient } from "./http.js";
import { SessionManager } from "./session.js";

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
    .action(async (options: CommonOptions & { baseUrl?: string; bindKey?: string; forceRenew?: boolean }) => {
      const baseUrl = options.baseUrl ?? process.env.TOPICLAB_BASE_URL;
      const bindKey = options.bindKey ?? process.env.TOPICLAB_BIND_KEY;
      const payload = await session.ensureSession({
        baseUrl,
        bindKey,
        forceRenew: options.forceRenew ?? false,
      });
      process.exit(emit(payload, options.json ?? false));
    });

  const manifestCommand = program.command("manifest");
  manifestCommand
    .command("get")
    .option("--base-url <url>")
    .option("--json")
    .action(async (options: CommonOptions & { baseUrl?: string }) => {
      const client = new TopicLabHTTPClient(options.baseUrl ?? process.env.TOPICLAB_BASE_URL ?? "http://127.0.0.1:8001");
      const payload = await client.requestJson("GET", "/api/v1/openclaw/cli-manifest");
      process.exit(emit(payload, options.json ?? false));
    });

  const policyCommand = program.command("policy");
  policyCommand
    .command("get")
    .option("--base-url <url>")
    .option("--json")
    .action(async (options: CommonOptions & { baseUrl?: string }) => {
      const client = new TopicLabHTTPClient(options.baseUrl ?? process.env.TOPICLAB_BASE_URL ?? "http://127.0.0.1:8001");
      const payload = await client.requestJson("GET", "/api/v1/openclaw/cli-policy-pack");
      process.exit(emit(payload, options.json ?? false));
    });

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
    .option("--json")
    .action(async (request: string, options: HelpAskOptions) => {
      const state = store.load();
      try {
        const payload = await session.requestWithAutoRenew("POST", "/api/v1/openclaw/cli-help", {
          jsonBody: {
            request,
            scene: options.scene,
            topic: options.topic,
            context: parseJsonArg(options.contextJson, {}),
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
      process.exit(emit(payload, options.json ?? false));
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
