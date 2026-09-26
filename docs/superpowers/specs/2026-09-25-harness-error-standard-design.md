# One error, whichever harness failed

**Date:** 2026-09-25.
**Touches:** agentpod (hub, node-agent, `apn`, two new harness plugins, one
existing plugin), supermessage (core + iOS first), two upstream reports.
**Precedes it:** PR #563 (no-op profile writes, ghost "ended without a reply").

## The problem, in one paragraph

When a model provider fails, what reaches a room depends on which harness the
agent runs. On 2026-09-25 at 05:47 UTC, krishna (OpenClaw on ashram) got three
failures in a row: Kimi's weekly quota was used up (403), then opencode-go
rejected two models with `400 MissingSessionID`. The room said only "The agent
completed without a reply." The provider's own sentence was in OpenClaw's log
on ashram and nowhere else. The six harnesses fail six different ways:

| Harness | On a provider failure, over ACP | Room today |
|---|---|---|
| Claude Code (claude-agent-acp 0.66.0) | rejects `session/prompt`, real text in `message` | real error |
| OpenCode 1.18.30 | rejects, real text in `message`; auth detail only in `data` | real error; auth generic |
| Codex (codex-acp 1.12.0) | most: error as `agent_message_chunk`, resolves `end_turn`; quota/401: rejects with `message: "Internal error"`, text in `data` | text posing as an answer; quota says "Internal error" |
| Hermes v0.21.3 | error as `agent_message_chunk`, resolves `end_turn` | text posing as an answer |
| Pi (pi-acp 0.0.33, pi 0.84.1) | ignores the assistant's `stopReason: "error"`, resolves `end_turn` | "completed without a reply" |
| OpenClaw 2026.7.1-2 (and 2026.9.6) | `handleChatEvent` maps gateway `state: "error"` to `end_turn` and drops `errorMessage` | "completed without a reply" |

The node-agent loses nothing (it moves adapter stdout as bytes). The ACP SDK
keeps `code`, `message` and `data`. **The hub** drops `data`
(`acp-sessions.ts:1145` reads `err.message` only), and treats any
`agent_message_chunk` as a productive turn.

**Decision this implements:** errors are standardised in AgentPod, not by
waiting for upstream. Upstream fixes are still reported; nothing here depends on
them being accepted.

## What is being built

### 1. One error shape (hub)

```ts
interface TurnError {
  kind:
    | "quota" | "rate_limit" | "auth" | "bad_request" | "context_exhausted"
    | "timeout" | "provider_unavailable" | "refusal" | "max_tokens"
    | "cancelled" | "node_offline" | "harness_exited" | "unknown";
  message: string;          // the provider's or harness's own words, untrimmed
  harness: string;          // "openclaw", "pi", …
  provider?: string;        // "kimi-coding"
  model?: string;           // "k2p6"
  attempts?: Array<{ provider: string; model: string; kind: TurnError["kind"]; message: string }>;
  retryable?: boolean;
  source: "acp-rejection" | "acp-stop-reason" | "session-state" | "hub" | "plugin";
}
```

Persisted as the existing `error` event's payload: `message` stays at the top
level so every current reader keeps working, and the rest is additive.

**Classification** is typed where the harness gives types and a heuristic where
it does not:

1. Typed fields in `data` when present: Claude Code's `data.errorKind`
   (claude-agent-sdk `SDKAssistantMessageError`) and Codex's
   `data.codexErrorInfo` (a string, or an object keyed by one category).
   Codex's words are in `data.message` / `data.additionalDetails`.
2. `stopReason` → `refusal`, `max_tokens`, `cancelled`.
   ACP's auth code (-32000) decides only when the text does not: adapters
   reuse it for other failures.
3. Session `state` reasons → `node_offline` ("node offline", "Couldn't reach
   the node."), `harness_exited`.
4. Text: HTTP status and fixed phrases ("usage limit", "rate limit", "401",
   "invalid api key", "timed out"). The table of phrases lives in one file with
   a test per row. Every entry cites the real message it came from.
5. Otherwise `unknown`, with `message` intact. An unknown kind with the real
   text is fine. A confident wrong kind is not.

**Reading `data`.** A rejection's text becomes `message`, extended with
`data.message` or `data.additionalDetails` when those add something. This alone
fixes Codex's "Internal error" and OpenCode's generic auth error.

### 2. Plugin error intake (node-agent)

A harness plugin reports a failed turn to its node, and the node forwards it to
the hub on the existing gateway connection as a new frame, `turn.error`.
The frame's zod schema, and `TurnError` itself, go into `packages/contract`
first, so the hub and node validate the same shape.

- **Transport:** a Unix socket owned by the node-agent, at
  `~/.agentpod/turn-errors.sock` (override: `AGENTPOD_TURN_ERROR_SOCKET`),
  mode 0600. The path comes from the home directory alone, so the node and a
  plugin running as the same user find the same path without either being
  told, whatever kind of service started them. On ashram the node and the
  OpenClaw gateway are both the `openclaw` user (checked 2026-09-25).
  - A plugin writes one JSON line (a `TurnErrorReport`, at most 16 KiB) and
    reads one line back: `ok`, or `error: <why>`.
  - The node refuses the obvious (not JSON, no message, no key to match by),
    wraps the rest unchanged as a `turn.error` frame, and queues it (64 deep)
    for the hub connection. A full queue answers `error: busy` rather than
    blocking the plugin.
  - The node advertises `turn.errors` in `hello` only when the socket opened.
- **Why not HTTP to the hub directly:** the plugin would need a hub credential.
  The node already has one, and it already knows which stations it runs.
- **Correlation:**
  - **Pi** is a child of the node's process tree (node → pi-acp → pi). The node
    sets `AGENTPOD_TURN_KEY=<acp session id>` in the adapter's environment, and
    Pi inherits it.
  - **OpenClaw's** gateway is a long-lived daemon that the node does not spawn,
    so the plugin sends the OpenClaw `sessionKey` (`agent:krishna:main`)
    instead. The hub already receives that key in `session_info_update._meta`
    for each live session, and matches on it.
- **Best-effort, always.** A plugin that cannot reach the socket logs once and
  carries on. The harness's own behaviour never changes.

### 3. The hub waits briefly before calling a turn silent

OpenClaw's bridge can resolve `session/prompt` before its `agent_end` hook
runs. When a turn ends with nothing produced, the hub holds its verdict for a
grace window (default 5 s). If a plugin `turn.error` for that session arrives
inside the window, it becomes the turn's error. If nothing arrives, the
existing "completed without a reply" path runs, unchanged. A `turn.error` that
arrives after the window is persisted and posted as a follow-up, never dropped.

### 4. Two new plugins, one extended

| Plugin | Hook | Sends |
|---|---|---|
| `integrations/openclaw/agentpod-errors` | `agent_end`, once per model attempt; a failed attempt's last assistant message has `stopReason: "error"` and the provider's `errorMessage` (`success` is `true` regardless). Reports a run after 2.5 s quiet (750 ms was too short on ashram: real attempts land 0.8–1.6 s apart, and the room got one error per attempt, 2026-09-26). Sends the provider's own error type (`providerErrorType`), which the hub classifies before the words. Needs `plugins.entries.agentpod-errors.hooks.allowConversationAccess: true`, or OpenClaw blocks the hook. `model_call_ended` is no use: its `outcome` was `completed` for a 403. | `TurnErrorReport` keyed by `ctx.sessionKey`, leading with the first attempt, listing all |
| `integrations/pi/agentpod-errors` (extension) | `message_end` where `role === "assistant"` and `stopReason === "error"` → `errorMessage`; sent at `agent_settled`, so Pi's own retries finish first | `TurnError` keyed by `AGENTPOD_TURN_KEY` |
| `integrations/hermes/agentpod-live` (existing) | the failure hook is to be confirmed against Hermes (whether `post_llm_call` fires on a failed call) | a `dev.agentpod.turn.error` to-device event beside its stream events, so harness-mode Hermes rooms get the same card. Hermes goes to Matrix directly, not through the hub, so it does not use the socket. |

Each plugin gets a contract test that runs inside the real harness, like
#552's Hermes contract: a fake model returns 429, and the test asserts the
`TurnError` that arrives. Each runs against the fleet ref, the latest release
and nightly.

**Installing:** `apn openclaw-errors` and `apn pi-errors`, with install,
status and remove, following `apn hermes-live` (#562). A plugin is only
installed by these commands, never by hand on a fleet host.

### 5. Codex typed failures (optional)

codex-acp has a structured session-failure path. It is gated on a JetBrains
vendor extension: `clientCapabilities._meta.jetbrains.air` with a version
number and `capabilities: ["sessionFailure"]` (codex-acp `dist/index.js`,
`AIR_SESSION_FAILURE_KEY`). Declaring it would mean presenting a JetBrains
extension we do not otherwise implement. **Not in the first cut.** §1's `data`
reading covers Codex's quota and auth errors. The remaining Codex text-as-answer
cases stay as they are unless they prove to matter.

### 6. Rooms carry the structure (hub → Matrix)

The room message stays an `m.notice` whose `body` is readable in any client:
`"Kimi (k2p6): You've reached your weekly (7-day) usage limit…"`. It gains a
namespaced content key that clients who know it can render:

```json
"dev.agentpod.turn_error": { "kind": "quota", "provider": "kimi-coding",
  "model": "k2p6", "harness": "openclaw", "retryable": false,
  "attempts": [ … ] }
```

The ❌ reaction on the trigger message is unchanged.

### 7. Supermessage renders it (iOS first)

- `supermessage-core` parses `dev.agentpod.turn_error` into an item view
  variant, `TurnError`.
- The SwiftUI app shows an error card: what failed (kind, in words), the
  provider and model, the full message (expandable), each attempt when there
  was a fallback chain, and a "try again" action that resends the trigger. The
  card replaces the plain notice row.
- The web client follows, from the same core type.
- Separately, and not dependent on this spec: hide `MembershipChange::None`
  items (join → join with no change), the same way `profileChange` is hidden.

### 8. Upstream reports (not relied on)

- **OpenClaw:** issue and PR. `handleChatEvent` on `state: "error"` should
  reject `session/prompt` with `errorMessage`, or emit the gateway's error
  message as an `agent_message_chunk` before resolving.
- **pi-acp:** issue and PR. Forward the assistant's `stopReason: "error"` and
  `errorMessage` as a rejection.

If either is accepted, the plugin becomes a redundant second path. The hub
keeps the first error it gets for a turn and discards the second, matched by
turn.

## Order of work

1. Hub: `TurnError`, the classifier, and reading `data` (§1). Ships alone and
   fixes Codex quota/auth and OpenCode auth straight away.
2. Supermessage: hide `MembershipChange::None` (§7, last bullet). Independent.
3. Node-agent intake, the `turn.error` frame, and the hub grace window
   (§2–3).
4. OpenClaw plugin, its contract test, and `apn openclaw-errors` (§4). Trial on
   krishna only, as #552 was trialled on strategy-sam, before any fleet
   rollout.
5. Pi plugin, its contract test, and `apn pi-errors` (§4).
6. Hub → Matrix structured content (§6), then the supermessage card, iOS first
   (§7).
7. Hermes `agentpod-live` error event (§4). Rides the next `agentpod-live`
   release.
8. Upstream issues and PRs (§8). Can start any time.

## What is not in this

- The provider failures themselves. These are operator actions:
  - Kimi's weekly quota.
  - opencode-go rejecting OpenClaw's calls for a missing `x-opencode-session`
    header.
  - buddhimaan having no kimi-coding key in its own auth store.

  This spec makes them visible. It does not fix them.
- Detecting error text that a harness sends as an ordinary answer (Codex,
  Hermes over ACP), other than through their own typed paths.

## Open questions

1. ~~Socket permissions on ashram.~~ Resolved 2026-09-25: the node-agent and
   the OpenClaw gateway both run as `openclaw`, so a 0600 socket suffices.
2. ~~Grace window length.~~ Measured 2026-09-25 against real OpenClaw
   2026.7.1-2 over ACP: the last `agent_end` fires ~130 ms before the prompt
   resolves. With the plugin's 2.5 s quiet period (raised from 750 ms after
   ashram's real 0.8–1.6 s gaps) the report lands ~2.4 s after, inside the
   hub's 5 s. Several reports for one turn are merged, first leading; a report
   after a turn already shows a plugin's error is dropped.
3. **Retry action.** Resending the trigger re-prompts with the same text. Is
   that acceptable when the error was quota, where it will certainly fail
   again? Proposal: hide "try again" for non-retryable kinds.
