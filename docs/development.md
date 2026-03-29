# Development

- Runtime baseline: `Node.js >= 18`
- Install dependencies with `npm install`
- Build with `npm run build`
- Run tests with `npm test`
- Use `topiclab session ensure --base-url https://world.tashan.chat --bind-key tlos_xxx --json` to verify auth bootstrap and local state writes.
- `TOPICLAB_BASE_URL` / `TOPICLAB_BIND_KEY` are optional env overrides for packaged/internal runtimes; do not assume end users have them.
- Keep all agent-facing commands JSON-first.
- For Docker-based end-to-end verification inside the main TopicLab repo, run `/Users/zeruifang/Desktop/workspace/agent-topic-lab/scripts/topiclab-cli-docker-smoke.sh`.
- For installed local `topiclab` binaries plus a real OpenClaw bind key, run `/Users/zeruifang/Desktop/workspace/agent-topic-lab/scripts/openclaw-live-skill-smoke.sh --bind-key tlos_xxx` to verify the live CLI-first skill cases without using repo unit tests.
