import { CLIState, StateStore } from "./config.js";
import { TopicLabCLIError } from "./errors.js";
import { normalizeBaseUrl, TopicLabHTTPClient } from "./http.js";

export class SessionManager {
  store: StateStore;

  constructor(store: StateStore = new StateStore()) {
    this.store = store;
  }

  loadState(): CLIState {
    return this.store.load();
  }

  async ensureSession(options: {
    baseUrl?: string;
    bindKey?: string;
    forceRenew?: boolean;
  }): Promise<Record<string, unknown>> {
    const state = this.store.load();
    if (options.baseUrl) {
      state.base_url = normalizeBaseUrl(options.baseUrl);
    }
    if (options.bindKey) {
      state.bind_key = options.bindKey;
    }
    if (!state.base_url) {
      throw new TopicLabCLIError("Missing TopicLab base URL. Provide --base-url or set TOPICLAB_BASE_URL.", {
        code: "missing_base_url",
        exitCode: 6,
      });
    }
    if (!state.bind_key) {
      throw new TopicLabCLIError("Missing bind key. Provide --bind-key or set TOPICLAB_BIND_KEY.", {
        code: "missing_bind_key",
        exitCode: 6,
      });
    }

    const client = new TopicLabHTTPClient(state.base_url);
    const payload =
      options.forceRenew || state.access_token
        ? await client.requestJson("POST", "/api/v1/openclaw/session/renew", {
            headers: { Authorization: `Bearer ${state.bind_key}` },
          })
        : await client.requestJson("GET", "/api/v1/openclaw/bootstrap", {
            params: { key: state.bind_key },
          });

    state.access_token = String(payload.access_token ?? "");
    state.agent_uid = payload.agent_uid ? String(payload.agent_uid) : null;
    state.openclaw_agent =
      payload.openclaw_agent && typeof payload.openclaw_agent === "object" && !Array.isArray(payload.openclaw_agent)
        ? (payload.openclaw_agent as Record<string, unknown>)
        : {};
    state.last_refreshed_at = new Date().toISOString();
    this.store.save(state);

    return {
      ok: true,
      base_url: state.base_url,
      agent_uid: state.agent_uid,
      openclaw_agent: state.openclaw_agent,
      last_refreshed_at: state.last_refreshed_at,
    };
  }

  async authedClient(): Promise<TopicLabHTTPClient> {
    let state = this.store.load();
    if (!state.base_url) {
      throw new TopicLabCLIError("Missing TopicLab base URL. Run `topiclab session ensure --base-url ...` first or set TOPICLAB_BASE_URL.", {
        code: "missing_base_url",
        exitCode: 6,
      });
    }
    if (!state.bind_key) {
      throw new TopicLabCLIError("Missing bind key. Run `topiclab session ensure --bind-key ...` first or set TOPICLAB_BIND_KEY.", {
        code: "missing_bind_key",
        exitCode: 6,
      });
    }
    if (!state.access_token) {
      await this.ensureSession({});
      state = this.store.load();
    }
    if (!state.base_url) {
      throw new TopicLabCLIError("Missing TopicLab base URL. Run `topiclab session ensure --base-url ...` first or set TOPICLAB_BASE_URL.", {
        code: "missing_base_url",
        exitCode: 6,
      });
    }
    return new TopicLabHTTPClient(state.base_url, state.access_token);
  }

  async requestWithAutoRenew(
    method: string,
    requestPath: string,
    options: {
      params?: Record<string, unknown>;
      jsonBody?: Record<string, unknown>;
    } = {},
  ): Promise<Record<string, unknown>> {
    try {
      const client = await this.authedClient();
      return await client.requestJson(method, requestPath, options);
    } catch (error) {
      if (!(error instanceof TopicLabCLIError) || error.statusCode !== 401) {
        throw error;
      }
    }
    await this.ensureSession({ forceRenew: true });
    const client = await this.authedClient();
    return client.requestJson(method, requestPath, options);
  }
}
