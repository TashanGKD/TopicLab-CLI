import { CLIState, StateStore } from "./config.js";
import { attachOpenClawDailyUpdateNotice, runDailyOpenClawUpdateCheck } from "./dailyUpdateCheck.js";
import { TopicLabCLIError } from "./errors.js";
import { normalizeBaseUrl, TopicLabHTTPClient, TopicLabJSON } from "./http.js";

export class SessionManager {
  store: StateStore;

  constructor(store: StateStore = new StateStore()) {
    this.store = store;
  }

  loadState(): CLIState {
    return this.store.load();
  }

  async enrichPayloadWithDailyOpenClawUpdate(payload: TopicLabJSON, client: TopicLabHTTPClient): Promise<TopicLabJSON> {
    const notice = await runDailyOpenClawUpdateCheck(this.store, client);
    return attachOpenClawDailyUpdateNotice(payload, notice);
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

    const publicClient = new TopicLabHTTPClient(state.base_url);
    const payload = (
      options.forceRenew || state.access_token
        ? await publicClient.requestJson("POST", "/api/v1/openclaw/session/renew", {
            headers: { Authorization: `Bearer ${state.bind_key}` },
          })
        : await publicClient.requestJson("GET", "/api/v1/openclaw/bootstrap", {
            params: { key: state.bind_key },
          })
    ) as Record<string, unknown>;

    state.access_token = String(payload.access_token ?? "");
    state.agent_uid = payload.agent_uid ? String(payload.agent_uid) : null;
    state.openclaw_agent =
      payload.openclaw_agent && typeof payload.openclaw_agent === "object" && !Array.isArray(payload.openclaw_agent)
        ? (payload.openclaw_agent as Record<string, unknown>)
        : {};
    state.last_seen_skill_version =
      typeof payload.skill_version === "string" && payload.skill_version.trim() ? payload.skill_version.trim() : state.last_seen_skill_version;
    state.last_seen_skill_updated_at =
      typeof payload.skill_updated_at === "string" && payload.skill_updated_at.trim()
        ? payload.skill_updated_at.trim()
        : state.last_seen_skill_updated_at;
    const payloadAskAgent =
      payload.ask_agent && typeof payload.ask_agent === "object" && !Array.isArray(payload.ask_agent)
        ? (payload.ask_agent as Record<string, unknown>)
        : null;
    if (payloadAskAgent) {
      state.ask_agent = {
        agent_url:
          typeof payloadAskAgent.agent_url === "string" && payloadAskAgent.agent_url.trim() ? payloadAskAgent.agent_url.trim() : null,
        agent_token:
          typeof payloadAskAgent.agent_token === "string" && payloadAskAgent.agent_token.trim()
            ? payloadAskAgent.agent_token.trim()
            : null,
        project_id:
          typeof payloadAskAgent.project_id === "string" && payloadAskAgent.project_id.trim() ? payloadAskAgent.project_id.trim() : null,
        session_id:
          typeof payloadAskAgent.session_id === "string" && payloadAskAgent.session_id.trim() ? payloadAskAgent.session_id.trim() : null,
      };
    }
    state.last_refreshed_at = new Date().toISOString();
    this.store.save(state);

    const authedHttp = new TopicLabHTTPClient(state.base_url, state.access_token);
    const basePayload: Record<string, unknown> = {
      ok: true,
      base_url: state.base_url,
      agent_uid: state.agent_uid,
      openclaw_agent: state.openclaw_agent,
      skill_version: state.last_seen_skill_version,
      skill_updated_at: state.last_seen_skill_updated_at,
      ask_agent: {
        configured: Boolean(
          state.ask_agent.agent_url &&
            state.ask_agent.agent_token &&
            state.ask_agent.project_id &&
            state.ask_agent.session_id,
        ),
        agent_url: state.ask_agent.agent_url,
        project_id: state.ask_agent.project_id,
        session_id: state.ask_agent.session_id,
      },
      last_refreshed_at: state.last_refreshed_at,
    };
    return (await this.enrichPayloadWithDailyOpenClawUpdate(basePayload, authedHttp)) as Record<string, unknown>;
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
  ): Promise<TopicLabJSON> {
    try {
      const client = await this.authedClient();
      const payload = await client.requestJson(method, requestPath, options);
      return await this.enrichPayloadWithDailyOpenClawUpdate(payload, client);
    } catch (error) {
      if (!(error instanceof TopicLabCLIError) || error.statusCode !== 401) {
        throw error;
      }
    }
    await this.ensureSession({ forceRenew: true });
    const client = await this.authedClient();
    const payload = await client.requestJson(method, requestPath, options);
    return await this.enrichPayloadWithDailyOpenClawUpdate(payload, client);
  }

  async requestFormWithAutoRenew(
    method: string,
    requestPath: string,
    options: {
      params?: Record<string, unknown>;
      fields?: Record<string, unknown>;
      files?: Array<{ fieldName: string; filePath: string }>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<TopicLabJSON> {
    try {
      const client = await this.authedClient();
      const payload = await client.requestForm(method, requestPath, options);
      return await this.enrichPayloadWithDailyOpenClawUpdate(payload, client);
    } catch (error) {
      if (!(error instanceof TopicLabCLIError) || error.statusCode !== 401) {
        throw error;
      }
    }
    await this.ensureSession({ forceRenew: true });
    const client = await this.authedClient();
    const payload = await client.requestForm(method, requestPath, options);
    return await this.enrichPayloadWithDailyOpenClawUpdate(payload, client);
  }

  async downloadBinaryWithAutoRenew(
    requestPath: string,
    options: {
      params?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ buffer: Buffer; contentType: string | null }> {
    try {
      const client = await this.authedClient();
      return await client.downloadBinary(requestPath, options);
    } catch (error) {
      if (!(error instanceof TopicLabCLIError) || error.statusCode !== 401) {
        throw error;
      }
    }
    await this.ensureSession({ forceRenew: true });
    const client = await this.authedClient();
    return client.downloadBinary(requestPath, options);
  }
}
