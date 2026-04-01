import { readTopiclabCliPackageVersion } from "./cliVersion.js";
import { TopicLabCLIError } from "./errors.js";

export interface AskAgentConfig {
  agentUrl: string;
  agentToken: string;
  projectId: string;
  sessionId: string;
}

export interface AskInvocationOptions {
  request: string;
  scene?: string;
  topic?: string;
  context?: unknown;
  topiclabCliVersion?: string;
  websiteSkillVersion?: string | null;
  websiteSkillUpdatedAt?: string | null;
  agentUid?: string | null;
  openclawAgent?: Record<string, unknown> | null;
  agentUrl?: string;
  agentToken?: string;
  projectId?: string;
  sessionId?: string;
}

export interface AskAgentConfigSource {
  agentUrl?: string | null;
  agentToken?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
}

type AskStreamEvent = Record<string, unknown> | string;

function hasValue(value: string | null | undefined): boolean {
  return Boolean(value && value.trim());
}

function hasStructuredValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function serializeContext(context: unknown): string | undefined {
  if (!hasStructuredValue(context)) {
    return undefined;
  }
  return JSON.stringify(context, null, 2);
}

function buildRuntimeMetadata(options: AskInvocationOptions): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    topiclab_cli_version: options.topiclabCliVersion?.trim() || readTopiclabCliPackageVersion(),
  };
  if (options.websiteSkillVersion?.trim()) {
    metadata.website_skill_version = options.websiteSkillVersion.trim();
  }
  if (options.websiteSkillUpdatedAt?.trim()) {
    metadata.website_skill_updated_at = options.websiteSkillUpdatedAt.trim();
  }
  if (options.agentUid?.trim()) {
    metadata.agent_uid = options.agentUid.trim();
  }
  if (hasStructuredValue(options.openclawAgent)) {
    metadata.openclaw_agent = options.openclawAgent;
  }
  return metadata;
}

function composePrompt(options: AskInvocationOptions): string {
  const sections = [options.request.trim()];

  if (options.scene?.trim()) {
    sections.push(`Scene: ${options.scene.trim()}`);
  }
  if (options.topic?.trim()) {
    sections.push(`Topic: ${options.topic.trim()}`);
  }
  const contextText = serializeContext(options.context);
  if (contextText) {
    sections.push(`Context JSON:\n${contextText}`);
  }
  sections.push(`Runtime Metadata JSON:\n${JSON.stringify(buildRuntimeMetadata(options), null, 2)}`);

  return sections.join("\n\n");
}

function parseSseBlock(block: string): AskStreamEvent[] {
  const dataLines = block
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return [];
  }

  const dataText = dataLines.join("\n");
  if (!dataText) {
    return [];
  }

  try {
    return [JSON.parse(dataText) as Record<string, unknown>];
  } catch {
    return [dataText];
  }
}

function flushSseBuffer(buffer: string): { events: AskStreamEvent[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.flatMap((block) => parseSseBlock(block));
  return { events, rest };
}

async function readSseEvents(response: Response): Promise<AskStreamEvent[]> {
  if (!response.body) {
    throw new TopicLabCLIError("No response body from ask agent", {
      code: "ask_missing_body",
      exitCode: 4,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: AskStreamEvent[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const flushed = flushSseBuffer(buffer);
    events.push(...flushed.events);
    buffer = flushed.rest;
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    events.push(...parseSseBlock(buffer));
  }

  return events;
}

export function resolveAskAgentConfig(overrides: AskAgentConfigSource = {}): AskAgentConfig | null {
  const config: Partial<AskAgentConfig> = {
    agentUrl: overrides.agentUrl?.trim() || undefined,
    agentToken: overrides.agentToken?.trim() || undefined,
    projectId: overrides.projectId?.trim() || undefined,
    sessionId: overrides.sessionId?.trim() || undefined,
  };

  const presentCount = Object.values(config).filter((value) => hasValue(value)).length;
  if (presentCount === 0) {
    return null;
  }
  if (presentCount !== 4) {
    throw new TopicLabCLIError(
      "Ask agent config is incomplete. Refresh the TopicLab session or provide url/token/project_id/session_id via flags.",
      {
        code: "ask_config_incomplete",
        exitCode: 6,
        detail: {
          missing: Object.entries(config)
            .filter(([, value]) => !hasValue(value))
            .map(([key]) => key),
        },
      },
    );
  }

  return config as AskAgentConfig;
}

export async function invokeAskAgent(options: AskInvocationOptions): Promise<Record<string, unknown>> {
  const config = resolveAskAgentConfig({
    agentUrl: options.agentUrl,
    agentToken: options.agentToken,
    projectId: options.projectId,
    sessionId: options.sessionId,
  });
  if (!config) {
    throw new TopicLabCLIError("Ask agent config is missing", {
      code: "ask_config_missing",
      exitCode: 6,
    });
  }

  const promptText = composePrompt(options);

  let response: Response;
  try {
    response = await fetch(config.agentUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.agentToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        content: {
          query: {
            prompt: [
              {
                type: "text",
                content: {
                  text: promptText,
                },
              },
            ],
          },
        },
        type: "query",
        session_id: config.sessionId,
        project_id: config.projectId,
      }),
    });
  } catch (error) {
    throw new TopicLabCLIError("Network error while calling ask agent", {
      code: "ask_network_error",
      exitCode: 3,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new TopicLabCLIError(`HTTP ${response.status} while calling ask agent`, {
      code: "ask_http_error",
      exitCode: 2,
      statusCode: response.status,
      detail: detail || response.statusText,
    });
  }

  const events = await readSseEvents(response);
  const runtimeMetadata = buildRuntimeMetadata(options);
  const payload: Record<string, unknown> = {
    ok: true,
    help_source: "agent_stream",
    mode: "agent_invoke",
    request: options.request,
    topiclab_cli_version:
      typeof runtimeMetadata.topiclab_cli_version === "string" ? runtimeMetadata.topiclab_cli_version : null,
    website_skill_version: options.websiteSkillVersion ?? null,
    website_skill_updated_at: options.websiteSkillUpdatedAt ?? null,
    agent_uid: options.agentUid ?? null,
    openclaw_agent: options.openclawAgent ?? null,
    project_id: config.projectId,
    session_id: config.sessionId,
    event_count: events.length,
    events,
  };

  if (options.scene) {
    payload.scene = options.scene;
  }
  if (options.topic) {
    payload.topic = options.topic;
  }
  if (hasStructuredValue(options.context)) {
    payload.context = options.context;
  }

  return payload;
}
