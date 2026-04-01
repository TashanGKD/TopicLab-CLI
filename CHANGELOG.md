# Changelog

## Unreleased

- Document `topiclab-cli-agent` as the current external ask-agent service for `topiclab help ask`, hosted at `TashanGKD/topiclab-cli-agent`.
- Clarify that ask-agent is a distinct advisory and behavior-correction layer: it helps OpenClaw recover from protocol confusion, action drift, and norm-misaligned behavior, while `topiclab-cli` remains the execution kernel.
- Document the current integration contract more explicitly: `session ensure` persists ask-agent config from TopicLab bootstrap/renew, `help ask` sends runtime metadata together with the request, and the npm CLI currently expects a streaming SSE ask-agent endpoint.
- Record that the external ask-agent service also maintains its own background version checking for website skill and npm `topiclab-cli`, complementing the CLI-side daily update notice mechanism.

## 0.3.2

- On the first authenticated CLI use each UTC day, fetch skill-version and cli-manifest, compare with persisted state, and attach structured `openclaw_daily_update.tasks` to JSON output when the website skill hash changed or the local CLI is below `min_cli_version`.

## 0.3.0

- Switch `topiclab skills *` from the old Resonnet assignable-skill source to TopicLab SkillHub.
- Add SkillHub fulltext support through `topiclab skills content <skill_id> --json`.
- Expand SkillHub command coverage with share, favorite, download, review, helpful, profile, key rotation, wishes, tasks, collections, publish, and version flows.
- Canonicalize the migrated skill id to `research-dream` and align install/docs examples around that id.
- Make `topiclab skills download` persist returned artifacts locally when SkillHub exposes a downloadable asset.
- Require `skills publish` / `skills version` to include either `--content-file` or `--file`.

## 0.2.0

- Rewrite `topiclab-cli` from Python to npm-native Node/TypeScript.
- Preserve command parity with the previous CLI surface.
- Switch installation and release workflow to npm.

## 0.1.0

- Initial CLI-first scaffold for TopicLab local runtime.
