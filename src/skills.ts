import fs from "node:fs";
import path from "node:path";

import { TopicLabCLIError } from "./errors.js";

const WORKSPACE_MARKER_FILES = ["USER.md", "SOUL.md", "MEMORY.md", "HEARTBEAT.md"] as const;
const WORKSPACE_MARKER_DIRS = [path.join(".claude", "skills"), "memory"] as const;

export function skillSlugFromId(skillId: string): string {
  const normalized = skillId.endsWith(".md") ? skillId.slice(0, -3) : skillId;
  return normalized.includes(":") ? normalized.split(":", 2)[1] : normalized;
}

function frontmatterBlock(content: string): string | null {
  if (!content.startsWith("---\n")) {
    return null;
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return null;
  }
  return content.slice(4, end).trim();
}

function parseMetadataObject(content: string): Record<string, unknown> {
  const block = frontmatterBlock(content);
  if (!block) {
    return {};
  }
  const match = block.match(/^metadata:\s*(.+)$/m);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[1].trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sanitizeSkillSlug(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "skill";
}

export function resolveInstallSlug(skillId: string, content: string): string {
  const metadata = parseMetadataObject(content);
  const openclaw = metadata.openclaw;
  if (openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)) {
    const skillKey = (openclaw as Record<string, unknown>).skillKey;
    if (typeof skillKey === "string" && skillKey.trim()) {
      return sanitizeSkillSlug(skillKey);
    }
  }
  return sanitizeSkillSlug(skillSlugFromId(skillId));
}

function isWorkspaceRoot(candidate: string): boolean {
  for (const fileName of WORKSPACE_MARKER_FILES) {
    if (fs.existsSync(path.join(candidate, fileName))) {
      return true;
    }
  }
  for (const dirName of WORKSPACE_MARKER_DIRS) {
    const dirPath = path.join(candidate, dirName);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      return true;
    }
  }
  return false;
}

export function resolveWorkspaceRoot(workspaceDir?: string, cwd = process.cwd()): string {
  if (workspaceDir) {
    const resolved = path.resolve(workspaceDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new TopicLabCLIError(`OpenClaw workspace directory not found: ${resolved}`, {
        code: "workspace_not_found",
        exitCode: 5,
      });
    }
    return resolved;
  }

  let current = path.resolve(cwd);
  while (true) {
    if (isWorkspaceRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new TopicLabCLIError(
    "Unable to infer OpenClaw workspace. Re-run with --workspace-dir <path>.",
    {
      code: "workspace_not_found",
      exitCode: 5,
    },
  );
}

export function installSkillToWorkspace(options: {
  skillId: string;
  content: string;
  workspaceDir?: string;
  cwd?: string;
  force?: boolean;
}): {
  workspace_root: string;
  install_slug: string;
  installed_path: string;
  overwritten: boolean;
} {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceDir, options.cwd);
  const installSlug = resolveInstallSlug(options.skillId, options.content);
  const destDir = path.join(workspaceRoot, ".claude", "skills", installSlug);
  const destPath = path.join(destDir, "SKILL.md");
  const overwritten = fs.existsSync(destPath);

  if (overwritten && !options.force) {
    throw new TopicLabCLIError(`Skill already exists at ${destPath}. Re-run with --force to overwrite.`, {
      code: "skill_exists",
      exitCode: 2,
    });
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(destPath, options.content, "utf8");

  return {
    workspace_root: workspaceRoot,
    install_slug: installSlug,
    installed_path: destPath,
    overwritten,
  };
}
