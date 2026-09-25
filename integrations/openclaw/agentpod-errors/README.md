# agentpod-errors (OpenClaw plugin)

This plugin tells AgentPod why an OpenClaw turn failed. Without it, the room only sees "The agent completed without a reply."

**Why it is needed.** When every model fails, OpenClaw's ACP bridge (`openclaw acp`) ends the prompt as a normal `end_turn` and discards the provider's words.
- `handleChatEvent` maps the gateway's `state: "error"` to `end_turn` and never reads `errorMessage`.
- Still true in 2026.9.6.
- The hub receives nothing, and the reason exists only in OpenClaw's own log.

**How it works.**
1. OpenClaw fires `agent_end` once per model attempt. For a failed attempt, the last assistant message has `stopReason: "error"` and the provider's `errorMessage`. `success` still says `true`.
2. The plugin collects a run's failed attempts. Once the run has been quiet for 750 ms, it writes one report to the AgentPod node on the same machine: a JSON line on `~/.agentpod/turn-errors.sock` (overridden by `AGENTPOD_TURN_ERROR_SOCKET`).
3. The node forwards the report to the hub as a `turn.error` frame. The hub matches it by the session key (`agent:<id>:main`) that it already saw over ACP.

The report leads with the first attempt, the model the agent is configured to use, and lists every attempt. If a fallback answered, nothing is reported.

**Properties.**
- It only observes: its single hook, `agent_end`, cannot change a turn.
- If no node is listening, it logs one warning and does nothing else.
- No dependencies and no build: it loads as plain ESM from its directory.

## Install

Install with `apn openclaw-errors`, not by hand on a fleet host. That command writes the same config the contract test uses: the plugin's directory in `plugins.load.paths`, and an `agentpod-errors` entry that is `enabled` with `hooks.allowConversationAccess: true`. OpenClaw blocks `agent_end` for non-bundled plugins without that flag, and says so in its gateway log:

```
typed hook "agent_end" blocked because non-bundled plugins must set plugins.entries.agentpod-errors.hooks.allowConversationAccess=true
```

## Test

```sh
node --test test/*.test.js                        # the plugin's own logic, no dependencies
OPENCLAW_BIN=openclaw node contract/run-in-openclaw.mjs   # inside a real OpenClaw
```

The contract test runs the plugin inside a real OpenClaw:
- A fake provider answers with Kimi's real 403 and opencode-go's real 400.
- A turn is driven over ACP, as the node drives it.
- The test asserts the one report that reaches a stand-in for the node's socket.

CI (`.github/workflows/openclaw-plugin.yml`) runs it against two versions:
- **fleet:** `openclaw-fleet.version`, on Node 22.
- **release:** npm's latest, on Node 24. OpenClaw 2026.9.x needs Node 24.16 or later.

A nightly failure opens an issue.
