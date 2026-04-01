import type { CLIState } from "./config.js";
import type { StateStore } from "./config.js";
import { readTopiclabCliPackageVersion } from "./cliVersion.js";
import { TopicLabHTTPClient, type TopicLabJSON } from "./http.js";

export type OpenClawUpdateTask =
  | {
      id: "refresh_website_skill";
      title: string;
      summary: string;
      actions: string[];
      skill_md_url: string;
      skill_version_check_url: string;
      remote_version: string;
      remote_updated_at: string;
    }
  | {
      id: "upgrade_topiclab_cli";
      title: string;
      summary: string;
      actions: string[];
      local_version: string;
      min_required_version: string;
    };

export interface OpenClawDailyUpdateNotice {
  schema: "topiclab.openclaw_daily_update.v1";
  checked_at: string;
  check_day_utc: string;
  local_cli_version: string;
  min_cli_version: string | null;
  server_skill_version: string | null;
  server_skill_updated_at: string | null;
  tasks: OpenClawUpdateTask[];
}

function utcYmd(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Lexicographic semver-ish compare for x.y.z numeric segments. Returns negative if a < b. */
export function semverCompare(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .trim()
      .split(/[.+-]/)
      .map((part) => {
        const n = parseInt(part.replace(/\D/g, ""), 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = norm(a);
  const pb = norm(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) {
      return -1;
    }
    if (da > db) {
      return 1;
    }
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function runDailyOpenClawUpdateCheck(
  store: StateStore,
  authedClient: TopicLabHTTPClient,
): Promise<OpenClawDailyUpdateNotice | null> {
  const state = store.load();
  const today = utcYmd();
  if (state.last_update_check_day === today) {
    return null;
  }
  if (!state.base_url || !state.access_token) {
    return null;
  }

  const publicClient = new TopicLabHTTPClient(authedClient.baseUrl, null);

  let skillBody: Record<string, unknown> | null = null;
  let manifestBody: Record<string, unknown> | null = null;

  try {
    const raw = await publicClient.requestJson("GET", "/api/v1/openclaw/skill-version");
    skillBody = asRecord(raw);
  } catch {
    skillBody = null;
  }

  try {
    const raw = await publicClient.requestJson("GET", "/api/v1/openclaw/cli-manifest");
    manifestBody = asRecord(raw);
  } catch {
    manifestBody = null;
  }

  const localVersion = readTopiclabCliPackageVersion();
  const minCli =
    manifestBody && typeof manifestBody.min_cli_version === "string" ? manifestBody.min_cli_version.trim() : null;

  const remoteVersion = skillBody ? stringField(skillBody, "version") : null;
  const remoteUpdatedAt = skillBody ? stringField(skillBody, "updated_at") : null;
  const skillPath = skillBody ? stringField(skillBody, "skill_url") : null;
  const checkPath = skillBody ? stringField(skillBody, "check_url") : null;

  const tasks: OpenClawUpdateTask[] = [];
  const base = authedClient.baseUrl.replace(/\/+$/, "");
  const skillMdUrl =
    skillPath !== null ? `${base}${skillPath.startsWith("/") ? "" : "/"}${skillPath}?key=${encodeURIComponent(state.access_token)}` : "";

  const prevSkill = state.last_seen_skill_version;
  if (remoteVersion && prevSkill !== null && prevSkill !== remoteVersion) {
    tasks.push({
      id: "refresh_website_skill",
      title: "刷新他山世界网站主 Skill",
      summary: `网站侧主 skill 内容版本已从 ${prevSkill} 更新为 ${remoteVersion}，请在 OpenClaw 中重新加载 skill 入口 URL 并同步核心文件（AGENTS.md / TOOLS.md / HEARTBEAT.md 等）。`,
      actions: [
        "在 OpenClaw 中打开当前 TopicLab skill 链接并重新拉取正文（或让宿主重新下载 skill.md）。",
        `可选自检：GET ${checkPath ? `${base}${checkPath.startsWith("/") ? "" : "/"}${checkPath}` : `${base}/api/v1/openclaw/skill-version`}`,
        "将变更摘要写入本地核心规则文件，不要整段粘贴全文。",
      ],
      skill_md_url: skillMdUrl || `${base}/api/v1/openclaw/skill.md?key=${encodeURIComponent(state.access_token)}`,
      skill_version_check_url: checkPath
        ? `${base}${checkPath.startsWith("/") ? "" : "/"}${checkPath}`
        : `${base}/api/v1/openclaw/skill-version`,
      remote_version: remoteVersion,
      remote_updated_at: remoteUpdatedAt ?? "",
    });
  }

  if (minCli && semverCompare(localVersion, minCli) < 0) {
    tasks.push({
      id: "upgrade_topiclab_cli",
      title: "升级 topiclab-cli",
      summary: `当前本机 topiclab-cli 为 ${localVersion}，服务器要求最低 ${minCli}。`,
      actions: [
        "在本机 shell 执行：npm update -g topiclab-cli --registry=https://registry.npmmirror.com",
        "若仍未满足最低版本，执行：npm install -g topiclab-cli@latest --registry=https://registry.npmmirror.com",
        "升级后执行：topiclab session ensure --json 验证会话。",
      ],
      local_version: localVersion,
      min_required_version: minCli,
    });
  }

  const next: CLIState = {
    ...state,
    last_update_check_day: today,
    last_seen_skill_version: remoteVersion ?? state.last_seen_skill_version,
    last_seen_skill_updated_at: remoteUpdatedAt ?? state.last_seen_skill_updated_at,
  };
  store.save(next);

  if (tasks.length === 0) {
    return null;
  }

  return {
    schema: "topiclab.openclaw_daily_update.v1",
    checked_at: new Date().toISOString(),
    check_day_utc: today,
    local_cli_version: localVersion,
    min_cli_version: minCli,
    server_skill_version: remoteVersion,
    server_skill_updated_at: remoteUpdatedAt,
    tasks,
  };
}

export function attachOpenClawDailyUpdateNotice(payload: TopicLabJSON, notice: OpenClawDailyUpdateNotice | null): TopicLabJSON {
  if (!notice || notice.tasks.length === 0) {
    return payload;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return { ...payload, openclaw_daily_update: notice };
}
