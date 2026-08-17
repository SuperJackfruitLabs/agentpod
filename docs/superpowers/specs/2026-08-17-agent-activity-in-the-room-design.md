# Agent activity in the room

**Status:** design, approved in outline 2026-08-17
**Spans:** `packages/contract`, `apps/hub` (matrix-as), `supermessage` (Rust core + Svelte)

## The problem

The hub is a wide funnel with a very narrow spout.

Every ACP `session/update` a harness emits is persisted verbatim
(`apps/hub/src/services/acp-sessions.ts:489-493`). The console renders most of
it. The Matrix path forwards **one** kind of update, and does so by returning
`undefined` for everything else:

```ts
/** The text of an `agent_message_chunk`, or undefined for anything else. */
function messageChunkText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.sessionUpdate !== "agent_message_chunk") return undefined;
  ...
```
— `apps/hub/src/services/matrix-as/outbound.ts:157-167`

So `tool_call`, `tool_call_update`, `plan`, `usage_update`,
`available_commands_update`, `session_info_update` and `current_mode_update` all
fall through, silently, with no `default` case and no logging.

The visible consequence: **a room watching an agent do twenty minutes of file
edits sees a typing indicator, then one message.** Everything the agent
actually *did* — every file read, every command run, every test — is discarded
at one function in one file.

This spec covers making that work visible without making the room worse.

## What reaches a Matrix client today

| Signal | Harness emits | Hub → Matrix | Client renders |
| --- | --- | --- | --- |
| `agent_message_chunk` | yes | yes — buffered, one `m.room.message` per turn; also to-device as `dev.agentpod.stream.delta` | yes |
| `agent_thought_chunk` | yes (202 in one observed Hermes turn) | **no** — dropped at `outbound.ts:163` | — |
| `tool_call` / `tool_call_update` | yes, full shape | **no** — not handled at all | — |
| permission request | yes | yes, **as prose only** | as a text bubble |
| `available_commands_update` | yes | no | — |
| `plan` | never observed from any harness | no | — |
| token usage / cost | **never emitted by any harness** | — | — |

The last two rows are why this spec does not mention plans, task lists, token
counters or cost meters. `plan` handling exists in the kaambaan coalescer and
has never fired. For tokens and cost, the bridge spike searched 1,108 captured
events for `inputTokens`, `outputTokens`, `costUsd` and `total_cost_usd` and
found **zero occurrences**; `usage_update` carries `{used, size}`, which is
context-window occupancy, not spend. **A component with nothing behind it is
not worth building**, and the client already has 45 lines arguing exactly that
(`customEvents.ts:517-561`).

## The governing principle

**The stream and the record are different channels.** This is not new here — it
is the argument `matrix-as/live.ts` already makes, and this spec extends it
rather than reopening it:

> The cost is that every intermediate state becomes a permanent event. That is
> not storage — this homeserver is 91 MB — but four things that are real:
> `/search` returns half-written fragments of one answer; back-pagination
> fetches twenty events to reveal one message; read markers drift as edits land
> after them; and every phone on the account receives the churn. Worst of all,
> more events per turn means more limited syncs, and a limited sync unloads the
> timeline.

That last clause is not hypothetical. On 2026-08-17 a limited sync collapsed a
live room from 19834px of history to 1001px in front of a reader
(supermessage#20). Anything that multiplies events per turn makes that more
frequent.

So:

- **Live activity is ephemeral**, delivered to-device, never in room history.
- **The durable record is one event per turn**, not one per action.
- **Reasoning is never durable at all.**

That third point is a decision, and `outbound.ts:160-162` already states it:
reasoning *"belongs in the console's transcript, not in a room people share,
where it would turn one answer into a monologue."* 202 thought chunks in a
single turn is the number behind that sentence. Thinking becomes watchable
live and is then gone. If someone needs it afterwards, the console's transcript
is the place that already has it, in full, addressed by session and seq.

## Architecture

Three channels, two of them new.

```
harness ──ACP──▶ hub ──┬─▶ to-device  dev.agentpod.thought.delta   (live, ephemeral)
                       ├─▶ to-device  dev.agentpod.tool.update     (live, ephemeral)
                       ├─▶ room       dev.agentpod.turn.v1         (durable, 1 per turn)
                       ├─▶ room       dev.agentpod.permission.v1   (durable, rare)
                       └─▶ room       m.room.message               (unchanged)
```

### 1. `dev.agentpod.thought.delta` — to-device

**Byte-for-byte the same content shape as `dev.agentpod.stream.delta`.** That
is the point: the client's `core::live::LiveState`, its seq-ordering, and
supermessage's `pacer.ts` all already handle "cumulative text with a monotonic
seq, at-least-once and unordered". Reusing the shape means the only new client
code is a second registration and a different pane; reusing the *type* would
mean the reader could not tell an answer from its reasoning.

```jsonc
{
  "room_id":    "!abc:id.agentpod.dev",
  "session_id": "sess_...",
  "seq":        7,        // monotonic per turn, independent of stream.delta's
  "text":       "...",    // EVERYTHING so far, not the increment
  "done":       false
}
```

Emitted under the same policy as text (`shouldSendDelta`: a boundary with ≥24
characters behind it, or a 1.5s backstop). Reasoning is lower-value than the
answer, so it reuses the policy rather than getting a tighter one.

### 2. `dev.agentpod.tool.update` — to-device

One event per `tool_call` / `tool_call_update`, forwarded as it happens.

```jsonc
{
  "room_id":      "!abc:id.agentpod.dev",
  "session_id":   "sess_...",
  "seq":          12,           // monotonic per turn
  "tool_call_id": "call_01...",  // the identity; updates merge onto it
  "title":        "Read src/main.ts",
  "kind":         "read",        // ACP's tool kind, passed through, may be absent
  "status":       "in_progress", // pending | in_progress | completed | failed
  "locations":    ["src/main.ts"]
}
```

`tool_call` and `tool_call_update` produce the same event; the client **upserts
by `tool_call_id`**, exactly as the console does — and for the same reason
recorded at `transcript.ts:299-305`: a buggy or hostile agent repeating a
`toolCallId` must merge, not produce two items with the same key.

Not forwarded: `content` (`rawInput` / `rawOutput` / diffs). Tool output is
unbounded — a `cat` of a large file, a full test log — and this is a live
ticker, not a viewer. `locations` and `title` are what answer "what is it doing
right now".

### 3. `dev.agentpod.turn.v1` — a room event, once per turn

The durable record. Sent **before** the answer flushes, so a room reads in the
order things happened: *did these things, then said this.*

```jsonc
{
  "schema_version": 1,
  "session_id": "sess_...",
  "tools": [
    { "id": "call_01...", "title": "Read src/main.ts", "kind": "read",    "status": "completed", "locations": ["src/main.ts"] },
    { "id": "call_02...", "title": "Run tests",        "kind": "execute", "status": "failed",    "locations": [] }
  ],
  "counts": { "total": 7, "failed": 1, "omitted": 0 }
}
```

- **Only sent when the turn used at least one tool.** A conversational turn
  produces exactly the events it does today.
- **`tools` is capped at `TURN_TOOLS_MAX = 20`**, with the overflow recorded in
  `counts.omitted`. A pathological turn cannot produce an unbounded event, and
  the count still tells the truth about what happened.
- `schema_version` is snake_case because that is what the client reads
  (`customEvents.ts:408-412`, `readSchemaVersion`).

**Why a custom event type and not `m.room.message` with an extension key.** The
client's dispatch card — described in its own source as *"this design's
signature element"* — is reached only via `MsgLikeKind::Other`, i.e. a
message-like custom event, which `timeline_event_filter` already whitelists.
That mechanism is **fully built and deliberately empty**: the production
registry holds one demo renderer and nothing else, and
`DECISION_BEARING_EVENT_TYPES` is an empty set shipped with 45 lines explaining
that shipping the mechanism unreachable was the point. This is the event type
it was waiting for.

The cost, stated plainly: **other Matrix clients render nothing for it.** The
answer still arrives as an ordinary `m.room.message`, so nothing essential is
hidden from Element — only the activity card. The alternative (an
`m.room.message` carrying a `dev.agentpod.turn` key) would render everywhere,
but needs new Rust plumbing to surface unknown content keys and bypasses the
mechanism above. This choice is reversible; adding a body later is additive.

### 4. `dev.agentpod.permission.v1` — a room event, alongside the existing prose

Approvals already reach rooms and already work. What they lack is structure: the
client gets prose and can only offer a text box.

**The existing prose message is sent unchanged.** This event is added beside it:

```jsonc
{
  "schema_version": 1,
  "session_id": "sess_...",
  "request_seq": 41,
  "title": "Write src/main.ts",
  "options": [
    { "option_id": "allow_once",   "name": "Allow once" },
    { "option_id": "allow_always", "name": "Allow always" },
    { "option_id": "reject",       "name": "Reject" }
  ]
}
```

**The answer path needs no new plumbing at all**, which is the part of this
design worth checking twice. `matchPermissionAnswer`
(`matrix-as/permissions.ts:87-105`) already accepts a bare number, the option's
name, **or its `optionId`**. So a button in the client sends one of those as an
ordinary `m.room.message` and the existing inbound path resolves it. No new hub
route, no change to `inbound.ts`, and — confirmed against the client — **no new
Tauri command**: supermessage has no outbound path for custom events at all
(`send_custom`, `send_event`, `send_raw` match nothing anywhere in the tree),
and this design needs none, because `timelineStore.send` already exists.

**The button sends the option's `name`, not its `option_id`.** The room
transcript is a shared human record, and `permissionPrompt`'s own doc comment
is the argument: names are printed alongside the numbers *"because '1' alone
would make the transcript unreadable afterwards"*. A button that leaves
`allow_once` in the room is the same mistake in a different alphabet, where
`Allow once` reads as what a person decided. `option_id` is carried in the
event anyway, so a future client can switch without a schema change.

The cost is that two options sharing a name resolve to whichever comes first.
That is a harness authoring its own menu badly, it is already true for anyone
typing the name today, and the numbers remain unambiguous.

Two events per approval request is acceptable: approvals are rare, and the
prose message is what keeps Element and reply-by-number working.

`DECISION_BEARING_EVENT_TYPES` gains its first member, `dev.agentpod.permission.v1`.

**Known limitation, not fixed here.** The hub's pending-permission map
(`permissions.ts:36`) is process memory. A hub restart drops in-flight requests
and the room has no way to learn that the question it is showing is dead.
Fixing that means persisting pending permissions, which is its own change.

### 5. The diagnostic

`outbound.ts` drops unknown `sessionUpdate` kinds with no record. The kaambaan
coalescer does not — it keeps `unmapped()` and `losses()`
(`bridge/coalesce.ts:104-111`) and lists dropped kinds explicitly *"so a NEW
kind shows up in `unmapped()` instead of joining this set by accident"*.

Add the same to the Matrix path: a module-level `Set` of kinds seen and not
handled, logged **once per kind per process** at `info`. Without this, the next
capability a harness gains will vanish here exactly as tool calls did, and
nothing will say so.

## Contract

New file `packages/contract/src/matrix-events.ts`, exporting zod schemas and
inferred types for all four payloads above, plus the shared vocabulary:

```ts
export const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
```

taken from ACP and matching the console's `TOOL_STATUSES`
(`transcript.ts:161-164`) exactly, so the two consumers cannot drift.

The contract is the shared vocabulary, so it changes first — per the repo's own
rule: *"Change here first when a frame/API shape changes."*

## Hub changes

All in `apps/hub/src/services/matrix-as/`.

**`live.ts`** — add `THOUGHT_DELTA_TYPE` and `TOOL_UPDATE_TYPE`, and the
content builders. `shouldSendDelta` and `endsAtBoundary` are reused unchanged.

**`outbound.ts`** —
- `Attachment` gains per-turn state: a thought buffer with its own
  `thoughtSeq`/`thoughtSentChars`/`thoughtSentAt` (mirroring the text ones), and
  an ordered `Map<toolCallId, ToolRecord>` for the turn.
- The `agent-update` case stops being a single `if` and becomes a switch over
  `payload.sessionUpdate`, handling `agent_message_chunk` (unchanged),
  `agent_thought_chunk`, `tool_call`, `tool_call_update`, and recording anything
  else in the unmapped set.
- The `state` case emits `dev.agentpod.turn.v1` before `flush()` when the turn's
  tool map is non-empty, then clears the per-turn state.
- The `permission-request` case sends the structured event after the prose.

**`permissions.ts`** — unchanged. Deliberately: the whole point of using
`option_id` is that this file already handles it.

## Client changes (supermessage)

**Rust core** — two new to-device handlers in `core/live.rs`, registered exactly
like `StreamDeltaToDeviceEventContent`, each with its own ruma `EventContent`
derive and `kind = ToDevice`. They forward to two new IPC channels.

The room events need **no** Rust change: `timeline_event_filter` already admits
`AnyMessageLikeEventContent::_Custom`, and `classify_content` already projects
it to `kind: "customMessage"` with `detail` = the raw event type and
`customPayload` = the parsed content.

**Renderers** — two `CustomEventRenderer`s registered on the shared
`customEventRegistry`:

```ts
export interface CustomEventRenderer {
  eventType: string;
  maxKnownSchemaVersion: number;
  render(content: unknown, body: string | null): CustomEventRenderResult;
}
```

Both read fields one level at a time with `safeStringField` and never recurse,
per that module's rules. The caps they must live within are already defined
there: `FIELD_MAX_COUNT = 12`, `FIELD_VALUE_MAX_CHARS = 300`,
`FIELD_LABEL_MAX_CHARS = 60`, and — the one that constrains the wire format —
**`DECISION_MAX_OPTIONS = 4`**.

That last cap is load-bearing and it fits: ACP permission requests in practice
offer allow-once / allow-always / reject-once / reject-always, which is exactly
four. A harness offering five would have the fifth dropped by `boundDecision`,
so the hub caps `options` at four and the renderer must not assume more.

**The decision path** — `Timeline.svelte:865`'s stub

```ts
console.warn("dispatch decision has no outbound event type yet", …)
```

becomes: send the chosen option through the existing `timelineStore.send`.

The renderer therefore puts the option's **name** in
`CustomEventDecisionOption.id` — not the `option_id` — because `id` is what
`onDecide` receives verbatim and what will be sent. That reads backwards until
you see that `id` here is a *client-side* identifier for an answer, explicitly
documented as "what a renderer's own event type calls this answer", not a
promise to echo a wire field.

**Live panes** — the thought stream reuses `pacer.ts` unchanged. Presentation
(a collapsed "thinking" disclosure, a tool ticker) is deliberately left to
implementation; the data contract is what this spec fixes.

## What this spec deliberately does not do

- **No token, cost or budget UI.** No harness emits the data.
- **No plan or task list.** `plan` has never been observed.
- **No slash-command palette.** `available_commands_update` is dropped on
  purpose in both bridges; that is its own decision, already made.
- **No tool output viewer.** `content`/`rawOutput` is unbounded; showing it
  needs a design for truncation and expansion that this does not attempt.
- **No roster preview for activity events.** `RoomSummary.lastEventType` is
  `null` for every custom event, because the matrix-sdk latest-event builder
  swallows `_Custom` into a catch-all with no hook. Already documented at
  `customEvents.ts:544` as an accepted blocker.

## Testing

**Contract** — zod round-trips per payload; a rejected payload for each
required field.

**Hub** (`bun test`, no DB needed for these):
- a `tool_call` produces a to-device event and **no** room event;
- a turn with tools emits exactly one `dev.agentpod.turn.v1`, **before** the
  answer message;
- a turn with no tools emits none;
- more than `TURN_TOOLS_MAX` tools caps the list and sets `counts.omitted`;
- `tool_call_update` merges onto its `tool_call` rather than appending;
- a repeated `toolCallId` merges (the console's hostile-agent case);
- `agent_thought_chunk` produces a to-device event and never a room event —
  the regression test for the decision above;
- an unknown `sessionUpdate` kind is recorded once in the unmapped set;
- per-turn tool state is cleared, so turn two does not report turn one's work.

**Client** — renderer unit tests against fixtures, following
`customEvents.test.ts`: a well-formed payload, a payload with a higher
`schema_version` (must still render, flagged `newerVersion`), a hostile payload
(nested objects where strings are expected — must degrade, never coerce), an
empty `tools` array, and a decision with more than four options.

**End to end** — the fleet is the test environment. Verified against a real
agent on `ashram` before the issue closes, per the repo's standing rule for
anything touching the live fleet.

## Sequencing

Four independently shippable pieces. Each is useful alone and none blocks the
next, so they need not land together:

1. **The diagnostic.** Smallest, and it makes everything after it observable —
   once it is in, anything the hub drops says so. Ship first regardless.
2. **Live activity** (`thought.delta`, `tool.update`). Room history untouched,
   so the least risky of the four, and the biggest visible change: a reader
   watching sees the agent work.
3. **The durable record** (`turn.v1`). The first piece that adds a room event
   per turn, so it is the one to measure limited-sync frequency against, before
   and after.
4. **Structured approvals** (`permission.v1`). Last, because it is the only one
   that touches an interaction that already works. The prose path keeps working
   throughout, so it stays purely additive until the buttons are trusted.

## Risks

**Volume.** One extra room event per tool-using turn, and one per approval. That
is the smallest increment that still produces a durable record, and it is
bounded — but it is not zero, and the limited-sync behaviour it feeds is the
thing that collapsed a room this morning. If measurement shows turn events
making limited syncs materially more frequent, the fallback is to fold the
activity into the answer message rather than send a second event.

**Silent invisibility elsewhere.** Element shows nothing for the activity card.
Acceptable while supermessage is the reading client; revisit if that stops
being true.

**Schema churn.** Tool `kind` is passed through from ACP without validation, so
a harness inventing a new kind lands as an unknown string. Renderers must treat
it as opaque display text, never switch on it exhaustively.
