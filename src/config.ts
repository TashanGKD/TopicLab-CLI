import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./env.js";
import { normalizeBaseUrl } from "./http.js";

export interface AskAgentState {
  agent_url: string | null;
  agent_token: string | null;
  project_id: string | null;
  session_id: string | null;
}

export interface CLIState {
  base_url: string | null;
  bind_key: string | null;
  access_token: string | null;
  agent_uid: string | null;
  openclaw_agent: Record<string, unknown>;
  ask_agent: AskAgentState;
  last_refreshed_at: string | null;
  /** UTC calendar day (YYYY-MM-DD) of last OpenClaw daily update check. */
  last_update_check_day: string | null;
  /** Server `skill-version` hash last observed after a daily check (for change detection). */
  last_seen_skill_version: string | null;
  /** Server `skill-version.updated_at` last observed after bootstrap/renew or daily check. */
  last_seen_skill_updated_at: string | null;
}

function envBaseUrl(): string | null {
  const raw = process.env.TOPICLAB_BASE_URL?.trim();
  return raw ? normalizeBaseUrl(raw) : null;
}

function envBindKey(): string | null {
  const raw = process.env.TOPICLAB_BIND_KEY?.trim();
  return raw || null;
}

export function defaultState(): CLIState {
  return {
    base_url: null,
    bind_key: null,
    access_token: null,
    agent_uid: null,
    openclaw_agent: {},
    ask_agent: {
      agent_url: null,
      agent_token: null,
      project_id: null,
      session_id: null,
    },
    last_refreshed_at: null,
    last_update_check_day: null,
    last_seen_skill_version: null,
    last_seen_skill_updated_at: null,
  };
}

function defaultHome(): string {
  if (process.env.TOPICLAB_CLI_HOME) {
    return path.resolve(process.env.TOPICLAB_CLI_HOME);
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.resolve(process.env.XDG_CONFIG_HOME, "topiclab-cli");
  }
  return path.join(os.homedir(), ".config", "topiclab-cli");
}

export class StateStore {
  home: string;
  statePath: string;

  constructor(home?: string) {
    this.home = home ?? defaultHome();
    fs.mkdirSync(this.home, { recursive: true });
    this.statePath = path.join(this.home, "state.json");
  }

  load(): CLIState {
    if (!fs.existsSync(this.statePath)) {
      return {
        ...defaultState(),
        base_url: envBaseUrl(),
        bind_key: envBindKey(),
      };
    }
    const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<CLIState>;
    const parsedAskAgent =
      parsed.ask_agent && typeof parsed.ask_agent === "object" && !Array.isArray(parsed.ask_agent)
        ? (parsed.ask_agent as Partial<AskAgentState>)
        : {};
    return {
      ...defaultState(),
      ...parsed,
      // Packaged/internal runtimes may inject these as env overrides.
      base_url: envBaseUrl() ?? parsed.base_url ?? null,
      bind_key: envBindKey() ?? parsed.bind_key ?? null,
      openclaw_agent: parsed.openclaw_agent ?? {},
      ask_agent: {
        agent_url: parsedAskAgent.agent_url ?? null,
        agent_token: parsedAskAgent.agent_token ?? null,
        project_id: parsedAskAgent.project_id ?? null,
        session_id: parsedAskAgent.session_id ?? null,
      },
      last_update_check_day: parsed.last_update_check_day ?? null,
      last_seen_skill_version: parsed.last_seen_skill_version ?? null,
      last_seen_skill_updated_at: parsed.last_seen_skill_updated_at ?? null,
    };
  }

  save(state: CLIState): void {
    const payload = {
      ...state,
      last_refreshed_at: state.last_refreshed_at ?? new Date().toISOString(),
    };
    fs.writeFileSync(this.statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
