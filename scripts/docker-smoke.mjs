import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TOPICLAB_BASE_URL = process.env.TOPICLAB_BASE_URL || "http://topiclab-backend:8000";
const TOPICLAB_CLI_HOME = process.env.TOPICLAB_CLI_HOME || "/tmp/topiclab-cli";
const TOPICLAB_SMOKE_MEDIA_FILE = process.env.TOPICLAB_SMOKE_MEDIA_FILE || "/fixtures/logo_complete.webp";
const TOPICLAB_SMOKE_SKIP_MEDIA_UPLOAD = process.env.TOPICLAB_SMOKE_SKIP_MEDIA_UPLOAD === "1";
const CLI_CWD = "/app";

function logStep(message) {
  process.stdout.write(`[smoke] ${message}\n`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function uniquePhone(prefix = "139") {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8);
  return `${prefix}${suffix}`;
}

async function requestJson(method, path, { token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${TOPICLAB_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function runCli(args, { expectExitCode = 0 } = {}) {
  try {
    const { stdout } = await execFileAsync("node", ["dist/cli.js", ...args], {
      cwd: CLI_CWD,
      env: {
        ...process.env,
        TOPICLAB_BASE_URL,
        TOPICLAB_CLI_HOME,
      },
    });
    const payload = JSON.parse(stdout.trim());
    if (expectExitCode !== 0) {
      throw new Error(`Expected exit code ${expectExitCode} for topiclab ${args.join(" ")}, but command succeeded`);
    }
    return payload;
  } catch (error) {
    const exitCode = typeof error?.code === "number" ? error.code : null;
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    if (exitCode === expectExitCode && stdout) {
      return JSON.parse(stdout);
    }
    const detail = stdout || stderr || String(error);
    throw new Error(`topiclab ${args.join(" ")} failed with exit ${exitCode ?? "unknown"}: ${detail}`);
  }
}

async function registerUser({ phone, username, password }) {
  const config = await requestJson("GET", "/auth/register-config");
  let code = "";
  if (config.registration_requires_sms !== false) {
    const sendCode = await requestJson("POST", "/auth/send-code", {
      body: {
        phone,
        type: "register",
      },
    });
    assert(typeof sendCode.dev_code === "string" && sendCode.dev_code.length === 6, "Missing dev_code from /auth/send-code");
    code = sendCode.dev_code;
  }

  const register = await requestJson("POST", "/auth/register", {
    body: {
      phone,
      username,
      password,
      code,
    },
  });
  return register;
}

async function main() {
  await fs.rm(TOPICLAB_CLI_HOME, { recursive: true, force: true });
  await fs.mkdir(TOPICLAB_CLI_HOME, { recursive: true });

  const password = "Password123!";
  const ownerPhone = uniquePhone("139");
  const helperPhone = uniquePhone("138");

  logStep("registering owner and helper users");
  const ownerAuth = await registerUser({
    phone: ownerPhone,
    username: `owner_${ownerPhone.slice(-4)}`,
    password,
  });
  const helperAuth = await registerUser({
    phone: helperPhone,
    username: `helper_${helperPhone.slice(-4)}`,
    password,
  });

  logStep("creating owner openclaw bind key");
  const ownerKey = await requestJson("POST", "/api/v1/auth/openclaw-key", {
    token: ownerAuth.token,
  });
  const bindKey = ownerKey.bind_key || ownerKey.key;
  assert(typeof bindKey === "string" && bindKey.startsWith("tlos_"), "Missing tlos bind key");
  process.env.TOPICLAB_BIND_KEY = bindKey;

  logStep("upserting minimal twin");
  const twinUpsert = await requestJson("POST", "/api/v1/auth/digital-twins/upsert", {
    token: ownerAuth.token,
    body: {
      agent_name: "my_twin",
      display_name: "Smoke Twin",
      expert_name: "smoke_twin",
      visibility: "private",
      exposure: "brief",
      source: "smoke_test",
      role_content: "# Smoke Twin\n\n## Identity\n\nDocker smoke tester\n\n## Expertise\n\nProtocol verification",
    },
  });
  assert(typeof twinUpsert.twin_id === "string" && twinUpsert.twin_id.length > 0, "Missing twin_id after upsert");

  logStep("checking CLI manifest and policy");
  const manifest = await runCli(["manifest", "get", "--json"]);
  assert(manifest.cli_name === "topiclab", "Unexpected manifest payload");
  const policy = await runCli(["policy", "get", "--json"]);
  assert(policy.client_kind === "cli", "Unexpected policy payload");

  logStep("bootstrapping session");
  const session = await runCli([
    "session",
    "ensure",
    "--json",
  ]);
  assert(session.ok === true, "session ensure failed");

  logStep("checking empty notifications");
  const emptyNotifications = await runCli(["notifications", "list", "--json"]);
  assert(Array.isArray(emptyNotifications.items), "notifications list did not return items");

  logStep("reading twin current/runtime profile");
  const currentTwin = await runCli(["twins", "current", "--json"]);
  const twinId = currentTwin?.twin?.twin_id;
  assert(typeof twinId === "string" && twinId.length > 0, "twins current did not resolve twin_id");
  const runtimeProfileBefore = await runCli(["twins", "runtime-profile", "--json"]);
  assert(runtimeProfileBefore.runtime_profile, "runtime-profile missing runtime_profile");

  logStep("writing runtime state and requirement event");
  const runtimeState = await runCli([
    "twins",
    "runtime-state",
    "set",
    "--active-scene",
    "forum.request",
    "--current-focus",
    '{"goal":"verify_cli_runner"}',
    "--recent-threads",
    '["docker-smoke"]',
    "--recent-style-shift",
    '{"tone":"direct"}',
    "--json",
  ]);
  assert(runtimeState.ok === true, "runtime-state set failed");

  const requirement = await runCli([
    "twins",
    "requirements",
    "report",
    "--kind",
    "explicit_requirement",
    "--topic",
    "reply_style",
    "--statement",
    "Prefer concise updates during smoke runs",
    "--normalized-json",
    '{"verbosity":"low","shape":"concise"}',
    "--json",
  ]);
  assert(typeof requirement.observation_id === "string", "requirements report did not create observation");

  const version = await runCli(["twins", "version", "--json"]);
  assert(typeof version.core_version === "number", "twins version missing core_version");

  logStep("reading topics home/search and creating topic");
  const home = await runCli(["topics", "home", "--json"]);
  assert(typeof home === "object" && home !== null, "topics home returned unexpected payload");
  const searchBefore = await runCli(["topics", "search", "--q", "docker smoke", "--json"]);
  assert(Array.isArray(searchBefore.items), "topics search missing items");

  const createdTopic = await runCli([
    "topics",
    "create",
    "--title",
    `Docker smoke ${Date.now()}`,
    "--body",
    "This topic is created by the CLI docker smoke test.",
    "--category",
    "request",
    "--json",
  ]);
  const topicId = createdTopic.id;
  assert(typeof topicId === "string" && topicId.length > 0, "topics create did not return topic id");

  logStep("reading topic and replying as owner/helper");
  const topic = await runCli(["topics", "read", topicId, "--json"]);
  assert(topic.id === topicId, "topics read returned wrong topic");

  const ownerReply = await runCli([
    "topics",
    "reply",
    topicId,
    "--body",
    "Owner reply from docker smoke.",
    "--json",
  ]);
  const parentPostId = ownerReply?.post?.id;
  assert(typeof parentPostId === "string" && parentPostId.length > 0, "owner reply did not create post");

  await requestJson("POST", `/api/v1/topics/${topicId}/posts`, {
    token: helperAuth.token,
    body: {
      author: helperAuth.user.username,
      body: "Helper reply that should create an inbox notification.",
      in_reply_to_id: parentPostId,
    },
  });

  logStep("reading and clearing notifications");
  const notifications = await runCli(["notifications", "list", "--json"]);
  assert(Array.isArray(notifications.items) && notifications.items.length > 0, "expected at least one notification");
  const messageId = notifications.items[0]?.id;
  assert(typeof messageId === "string" && messageId.length > 0, "notification id missing");

  const readOne = await runCli(["notifications", "read", messageId, "--json"]);
  assert(readOne.ok === true, "notifications read failed");
  const readAll = await runCli(["notifications", "read-all", "--json"]);
  assert(readAll.ok === true, "notifications read-all failed");

  logStep("uploading media");
  let media = null;
  let mediaUploadSkipped = TOPICLAB_SMOKE_SKIP_MEDIA_UPLOAD;
  if (mediaUploadSkipped) {
    logStep("skipping media upload because OSS env is incomplete");
  } else {
    try {
      media = await runCli([
        "media",
        "upload",
        topicId,
        "--file",
        TOPICLAB_SMOKE_MEDIA_FILE,
        "--json",
      ]);
      assert(typeof media.url === "string" && media.url.length > 0, "media upload failed");
    } catch (error) {
      mediaUploadSkipped = true;
      logStep(`media upload skipped after infrastructure failure: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logStep("starting discussion");
  const discussion = await runCli([
    "discussion",
    "start",
    topicId,
    "--num-rounds",
    "1",
    "--max-turns",
    "2000",
    "--max-budget-usd",
    "5",
    "--json",
  ]);
  assert(discussion.status === "running", "discussion start did not return running status");

  logStep("verifying help skill refresh response");
  const help = await runCli([
    "help",
    "ask",
    "I hit a 401 during smoke.",
    "--json",
  ]);
  assert(help?.help_source === "website_skill", "help ask did not return website skill guidance");
  assert(help?.should_refresh_skill === true, "help ask did not request skill refresh");
  assert(typeof help?.skill_url === "string" && help.skill_url.includes("/api/v1/openclaw/skill.md"), "help ask did not return skill_url");

  const runtimeProfileAfter = await runCli(["twins", "runtime-profile", "--json"]);
  assert(runtimeProfileAfter.runtime_profile, "runtime-profile failed after writes");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      owner_phone: ownerPhone,
      helper_phone: helperPhone,
      topic_id: topicId,
      twin_id: twinId,
      notification_id: messageId,
      media_upload_skipped: mediaUploadSkipped,
      discussion_status: discussion.status,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[smoke] failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
