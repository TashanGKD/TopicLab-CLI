import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLI_MODULE_URL, isDirectEntrypoint, main } from "../src/cli.js";
import { TopicLabHTTPClient } from "../src/http.js";
import { SessionManager } from "../src/session.js";

const originalFetch = global.fetch;
const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const TEST_BASE_URL = "https://world.tashan.chat";
const TEST_BIND_KEY = "tlos_test";

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
      baseUrl: TEST_BASE_URL,
      bindKey: TEST_BIND_KEY,
    });

    expect(payload.agent_uid).toBe("oc_123");
    const state = JSON.parse(fs.readFileSync(path.join(tmpHome, "state.json"), "utf8"));
    expect(state.access_token).toBe("tloc_test");
  });

  it("manifest get uses cli-manifest route", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ client_kind: "cli", cli_name: "topiclab" }));

    const exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    await expect(main(["node", "topiclab", "manifest", "get", "--base-url", TEST_BASE_URL, "--json"])).rejects.toThrow(
      "exit:0",
    );

    expect(exitMock).toHaveBeenCalledWith(0);
    const payload = JSON.parse(stdout);
    expect(payload.cli_name).toBe("topiclab");
    expect(global.fetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/api/v1/openclaw/cli-manifest`, expect.anything());
  });

  it("treats symlinked launcher path as direct entrypoint", () => {
    const realCli = fileURLToPath(CLI_MODULE_URL);
    const symlinkCli = path.join(tmpHome, "topiclab");
    fs.symlinkSync(realCli, symlinkCli);

    expect(isDirectEntrypoint(realCli)).toBe(true);
    expect(isDirectEntrypoint(symlinkCli)).toBe(true);
    expect(isDirectEntrypoint(path.join(tmpHome, "missing-cli"))).toBe(false);
  });

  it("apps list filters by query locally", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: TEST_BASE_URL,
          bind_key: TEST_BIND_KEY,
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
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        version: "catalog_1",
        count: 2,
        list: [
          { id: "scientify", name: "Scientify", tags: ["research", "automation"] },
          { id: "manim-creator", name: "Manim Creator", tags: ["visualization"] },
        ],
      }),
    );

    await expect(main(["node", "topiclab", "apps", "list", "--q", "scient", "--json"])).rejects.toThrow("exit:0");

    expect(exitMock).toHaveBeenCalledWith(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(1);
    expect(parsed.list[0].id).toBe("scientify");
  });

  it("apps topic bootstraps an app discussion topic", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: TEST_BASE_URL,
          bind_key: TEST_BIND_KEY,
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
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ created: true, topic: { id: "topic_123" } }));

    await expect(main(["node", "topiclab", "apps", "topic", "scientify", "--json"])).rejects.toThrow("exit:0");

    expect(exitMock).toHaveBeenCalledWith(0);
    expect(global.fetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/api/v1/apps/scientify/topic`, expect.anything());
    expect(JSON.parse(stdout)).toMatchObject({ topic: { id: "topic_123" } });
  });

  it("notifications list uses inbox route", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: TEST_BASE_URL,
          bind_key: TEST_BIND_KEY,
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
    expect(global.fetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/api/v1/me/inbox?limit=20&offset=0`, expect.anything());
  });

  it("maps 404 into topiclab error", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "missing" }), { status: 404 }));

    await expect(
      new TopicLabHTTPClient(TEST_BASE_URL, "tloc_test").requestJson("GET", "/api/v1/openclaw/twins/current"),
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
          base_url: TEST_BASE_URL,
          bind_key: TEST_BIND_KEY,
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
          base_url: TEST_BASE_URL,
          bind_key: TEST_BIND_KEY,
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
          base_url: TEST_BASE_URL,
          bind_key: TEST_BIND_KEY,
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

  it("help ask returns website skill refresh guidance", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: TEST_BASE_URL,
          bind_key: TEST_BIND_KEY,
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
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        help_source: "website_skill",
        mode: "reload_skill",
        should_refresh_skill: true,
        skill_url: `${TEST_BASE_URL}/api/v1/openclaw/skill.md?key=tloc_test`,
      }),
    );

    await expect(
      main(["node", "topiclab", "help", "ask", "我现在不知道该怎么恢复会话", "--json"]),
    ).rejects.toThrow("exit:0");

    expect(exitMock).toHaveBeenCalledWith(0);
    expect(JSON.parse(stdout)).toMatchObject({
      help_source: "website_skill",
      mode: "reload_skill",
      should_refresh_skill: true,
    });
  });

  it("manifest get fails fast when TOPICLAB_BASE_URL is missing", async () => {
    const exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    await expect(main(["node", "topiclab", "manifest", "get", "--json"])).rejects.toThrow("exit:6");

    expect(exitMock).toHaveBeenCalledWith(6);
    expect(JSON.parse(stdout)).toMatchObject({
      error: { code: "missing_base_url" },
    });
  });

  it("env overrides persisted routing and bind state for packaged runtimes", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "state.json"),
      JSON.stringify(
        {
          base_url: "https://stale.example.com",
          bind_key: "tlos_stale",
          access_token: "tloc_test",
          agent_uid: "oc_123",
          openclaw_agent: {},
          last_refreshed_at: "2026-03-27T00:00:00+00:00",
        },
        null,
        2,
      ),
    );
    process.env.TOPICLAB_BASE_URL = TEST_BASE_URL;
    process.env.TOPICLAB_BIND_KEY = TEST_BIND_KEY;

    expect(new SessionManager().loadState()).toMatchObject({
      base_url: TEST_BASE_URL,
      bind_key: TEST_BIND_KEY,
    });
  });
});
