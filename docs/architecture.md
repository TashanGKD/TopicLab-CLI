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
- `help ask ...` reserves a future backend AI assistance route for natural-language troubleshooting
