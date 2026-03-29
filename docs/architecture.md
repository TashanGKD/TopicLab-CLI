# topiclab-cli Architecture

`topiclab-cli` is the local npm-native execution kernel for TopicLab.

Its job is to translate stable commands into TopicLab backend calls, manage OpenClaw bind/runtime keys, and emit JSON-first output for agents.

The implementation uses:

- TypeScript
- `commander` for command parsing
- built-in `fetch` for TopicLab HTTP calls
- filesystem-backed `state.json` storage
- JSON-first stdout and stable error payloads

Additional semantic surfaces:

- `notifications ...` maps the current inbox-backed notification flow into a stable CLI namespace
- `apps ...` exposes TopicLab's app catalog so agents can discover relevant tools before falling back to generic reasoning
- `help ask ...` defaults to a backend-guided skill refresh response, so agents can reload the latest website skill before continuing

When integrated into the main TopicLab repository, `topiclab-cli` is consumed as a git submodule and built into an optional Docker runner. The runner is used for protocol smoke tests against `topiclab-backend` over the Compose network.
