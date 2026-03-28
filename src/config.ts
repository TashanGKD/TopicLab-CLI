import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CLIState {
  base_url: string;
  bind_key: string | null;
  access_token: string | null;
  agent_uid: string | null;
  openclaw_agent: Record<string, unknown>;
  last_refreshed_at: string | null;
}

export function defaultState(): CLIState {
  return {
    base_url: "http://127.0.0.1:8001",
    bind_key: null,
    access_token: null,
    agent_uid: null,
    openclaw_agent: {},
    last_refreshed_at: null,
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
      return defaultState();
    }
    const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<CLIState>;
    return {
      ...defaultState(),
      ...parsed,
      openclaw_agent: parsed.openclaw_agent ?? {},
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
