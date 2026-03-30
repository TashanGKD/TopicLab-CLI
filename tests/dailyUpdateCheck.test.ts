import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runDailyOpenClawUpdateCheck, semverCompare } from "../src/dailyUpdateCheck.js";
import { StateStore } from "../src/config.js";
import { TopicLabHTTPClient } from "../src/http.js";

const originalFetch = global.fetch;

describe("dailyUpdateCheck", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("semverCompare orders versions", () => {
    expect(semverCompare("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(semverCompare("0.3.1", "0.1.0")).toBeGreaterThan(0);
    expect(semverCompare("1.0.0", "1.0.0")).toBe(0);
  });

  it("runDailyOpenClawUpdateCheck skips when already checked today", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "topiclab-daily-"));
    const store = new StateStore(tmp);
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(tmp, "state.json"),
      JSON.stringify({
        base_url: "https://world.tashan.chat",
        bind_key: "tlos_x",
        access_token: "tloc_x",
        agent_uid: "oc_1",
        openclaw_agent: {},
        last_refreshed_at: "2026-03-27T00:00:00+00:00",
        last_update_check_day: today,
        last_seen_skill_version: "aaa",
      }),
    );
    const client = new TopicLabHTTPClient("https://world.tashan.chat", "tloc_x");
    global.fetch = vi.fn();
    await expect(runDailyOpenClawUpdateCheck(store, client)).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("runDailyOpenClawUpdateCheck emits skill and cli tasks when versions drift", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "topiclab-daily-"));
    const store = new StateStore(tmp);
    fs.writeFileSync(
      path.join(tmp, "state.json"),
      JSON.stringify({
        base_url: "https://world.tashan.chat",
        bind_key: "tlos_x",
        access_token: "tloc_x",
        agent_uid: "oc_1",
        openclaw_agent: {},
        last_refreshed_at: "2026-03-27T00:00:00+00:00",
        last_update_check_day: null,
        last_seen_skill_version: "oldhash_oldhash",
      }),
    );
    const client = new TopicLabHTTPClient("https://world.tashan.chat", "tloc_x");
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "newhash_newhash",
            updated_at: "2026-03-30T12:00:00Z",
            skill_url: "/api/v1/openclaw/skill.md",
            check_url: "/api/v1/openclaw/skill-version",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ min_cli_version: "99.0.0" }), {
          headers: { "content-type": "application/json" },
        }),
      );

    const notice = await runDailyOpenClawUpdateCheck(store, client);
    expect(notice?.tasks.map((t) => t.id)).toEqual(["refresh_website_skill", "upgrade_topiclab_cli"]);
    expect(notice?.tasks[0]).toMatchObject({
      id: "refresh_website_skill",
      remote_version: "newhash_newhash",
    });
    expect((notice?.tasks[0] as { skill_md_url: string }).skill_md_url).toContain("skill.md?key=tloc_x");

    const saved = JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8"));
    expect(saved.last_seen_skill_version).toBe("newhash_newhash");
    expect(saved.last_update_check_day).toBe(new Date().toISOString().slice(0, 10));
  });
});
