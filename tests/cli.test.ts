import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { TopicLabHTTPClient } from "../src/http.js";
import { SessionManager } from "../src/session.js";

const originalFetch = global.fetch;
const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

function jsonResponse(payload: Record<string, unknown>, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("topiclab cli", () => {
  let tmpHome: string;
  let stdout = "";

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "topiclab-cli-"));
    process.env.TOPICLAB_CLI_HOME = tmpHome;
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    delete process.env.TOPICLAB_CLI_HOME;
  });

  it("session ensure bootstraps and persists state", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "tloc_test",
        agent_uid: "oc_123",
        openclaw_agent: { handle: "cli-user" },
      }),
    );

    const payload = await new SessionManager().ensureSession({
      baseUrl: "http://127.0.0.1:8001",
      bindKey: "tlos_test",
    });

    expect(payload.agent_uid).toBe("oc_123");
    const state = JSON.parse(fs.readFileSync(path.join(tmpHome, "state.json"), "utf8"));
    expect(state.access_token).toBe("tloc_test");
  });

  it("manifest get uses cli-manifest route", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ client_kind: "cli", cli_name: "topiclab" }));

    const payload = await new TopicLabHTTPClient("http://127.0.0.1:8001").requestJson(
      "GET",
      "/api/v1/openclaw/cli-manifest",
    );

    expect(payload.cli_name).toBe("topiclab");
    expect(global.fetch).toHaveBeenCalledWith("http://127.0.0.1:8001/api/v1/openclaw/cli-manifest", expect.anything());
  });

  it("notifications list uses inbox route", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: "http://127.0.0.1:8001",
          bind_key: "tlos_test",
          access_token: "tloc_test",
          agent_uid: "oc_123",
          openclaw_agent: {},
          last_refreshed_at: "2026-03-27T00:00:00+00:00",
        },
        null,
        2,
      ),
    );

    const exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code ?? 0}`);
    });
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ items: [], unread_count: 0 }));

    await expect(main(["node", "topiclab", "notifications", "list", "--json"])).rejects.toThrow("exit:0");

    expect(exitMock).toHaveBeenCalledWith(0);
    expect(global.fetch).toHaveBeenCalledWith("http://127.0.0.1:8001/api/v1/me/inbox?limit=20&offset=0", expect.anything());
  });

  it("maps 404 into topiclab error", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "missing" }), { status: 404 }));

    await expect(
      new TopicLabHTTPClient("http://127.0.0.1:8001", "tloc_test").requestJson("GET", "/api/v1/openclaw/twins/current"),
    ).rejects.toMatchObject({
      message: "HTTP 404 while calling TopicLab",
      code: "not_found",
    });
  });

  it("requirements report uses observation route", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: "http://127.0.0.1:8001",
          bind_key: "tlos_test",
          access_token: "tloc_test",
          agent_uid: "oc_123",
          openclaw_agent: { handle: "cli-user" },
          last_refreshed_at: "2026-03-27T00:00:00+00:00",
        },
        null,
        2,
      ),
    );

    const exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code ?? 0}`);
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, observation_id: "obs_1", merge_status: "pending_review" }));

    await expect(
      main([
        "node",
        "topiclab",
        "twins",
        "requirements",
        "report",
        "--twin-id",
        "twin_123",
        "--kind",
        "explicit_requirement",
        "--topic",
        "discussion_style",
        "--statement",
        "prefer concise replies",
        "--normalized-json",
        "{\"verbosity\":\"low\"}",
        "--evidence-json",
        "[{\"message_id\":\"msg_1\",\"excerpt\":\"以后回复简短一点。\"}]",
        "--json",
      ]),
    ).rejects.toThrow("exit:0");

    expect(exitMock).toHaveBeenCalledWith(0);
    const [, options] = vi.mocked(global.fetch).mock.calls[0];
    expect(options?.headers).toMatchObject({ Authorization: "Bearer tloc_test" });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      observation_type: "explicit_requirement",
      payload: {
        topic: "discussion_style",
        normalized: { verbosity: "low" },
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({ observation_id: "obs_1" });
  });

  it("invalid normalized json exits nonzero", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: "http://127.0.0.1:8001",
          bind_key: "tlos_test",
          access_token: "tloc_test",
          agent_uid: "oc_123",
          openclaw_agent: {},
          last_refreshed_at: "2026-03-27T00:00:00+00:00",
        },
        null,
        2,
      ),
    );

    const exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    await expect(
      main([
        "node",
        "topiclab",
        "twins",
        "requirements",
        "report",
        "--twin-id",
        "twin_123",
        "--kind",
        "explicit_requirement",
        "--topic",
        "discussion_style",
        "--statement",
        "prefer concise replies",
        "--normalized-json",
        "{bad json",
        "--json",
      ]),
    ).rejects.toThrow("exit:2");

    expect(exitMock).toHaveBeenCalledWith(2);
    expect(JSON.parse(stdout)).toMatchObject({
      error: { code: "invalid_json_argument" },
    });
  });

  it("renews on 401 and retries once", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: "http://127.0.0.1:8001",
          bind_key: "tlos_test",
          access_token: "expired_token",
          agent_uid: "oc_123",
          openclaw_agent: {},
          last_refreshed_at: "2026-03-27T00:00:00+00:00",
        },
        null,
        2,
      ),
    );

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "expired" }), { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "renewed", agent_uid: "oc_123", openclaw_agent: {} }))
      .mockResolvedValueOnce(jsonResponse({ twin: { twin_id: "twin_123" } }));

    const payload = await new SessionManager().requestWithAutoRenew("GET", "/api/v1/openclaw/twins/current");

    expect(payload).toMatchObject({ twin: { twin_id: "twin_123" } });
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(3);
  });

  it("maps missing help endpoint into cli_help_unavailable", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: "http://127.0.0.1:8001",
          bind_key: "tlos_test",
          access_token: "tloc_test",
          agent_uid: "oc_123",
          openclaw_agent: { handle: "cli-user" },
          last_refreshed_at: "2026-03-27T00:00:00+00:00",
        },
        null,
        2,
      ),
    );

    const exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code ?? 0}`);
    });
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "missing" }), { status: 404 }));

    await expect(
      main(["node", "topiclab", "help", "ask", "我现在不知道该怎么恢复会话", "--json"]),
    ).rejects.toThrow("exit:7");

    expect(exitMock).toHaveBeenCalledWith(7);
    expect(JSON.parse(stdout)).toMatchObject({
      error: { code: "cli_help_unavailable" },
    });
  });
});
