# agentpod-errors (Pi extension)

This extension tells AgentPod why a Pi turn failed. Without it, the room only sees "The agent completed without a reply."

**Why it is needed.** pi-acp forwards Pi's text, thinking and tool deltas over ACP, and nothing else. When a model call fails, the failure never leaves Pi:
- the assistant message has `stopReason: "error"` and the provider's `errorMessage`, and neither is forwarded;
- the ACP prompt resolves as a normal `end_turn`.

This is true of pi-acp 0.0.33 and 0.0.34.

**How it works.**
1. Pi fires `message_end` for every attempt, including its own retries. For a failed attempt, `errorMessage` is `"<status> <json body>"`.
2. The extension collects a turn's failed attempts.
3. When Pi fires `agent_settled`, it writes one report to the AgentPod node's intake socket, `~/.agentpod/turn-errors.sock`. The report is keyed by `AGENTPOD_ACP_SESSION`: the node sets it on the adapter it spawns, and pi-acp passes its environment on to Pi.

A successful retry clears the failures before it.

**Properties.**
- It only observes.
- A Pi started by hand has no hub session, so it reports nothing.
- If no node is listening, it logs one warning and does nothing else.

## Install

Install with `apn pi-errors enable --apply`, not by hand. It writes this file as `~/.pi/agent/extensions/agentpod-errors.ts`:
- **A top-level file,** so pi-acp's session banner lists it and a reader can see it is there.
- **Nothing to restart:** each Pi session pi-acp starts loads it.

## Test

```sh
node --experimental-strip-types --test test/*.test.mjs   # unit tests, no dependencies
node contract/run-in-pi.mjs                              # inside a real Pi under pi-acp
```

The contract test drives two turns over ACP through pi-acp, exactly as the node does, against a fake provider:
- Kimi's real 403;
- a 529 that Pi retries twice.

It asserts:
- exactly one report per failed turn, keyed by the hub session;
- the bare sentence, with its HTTP status and the provider's error type;
- Pi's retries arriving as attempts of that one report.

CI (`.github/workflows/pi-plugin.yml`) runs it against two versions:
- **fleet:** `pi-fleet.version` with pi-acp 0.0.33;
- **release:** npm's latest.

A nightly failure opens an issue.
