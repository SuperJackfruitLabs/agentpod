# A question reaches the room

**Status:** proposed, 2026-10-02
**Companion spec:** `superpipeline → docs/superpowers/specs/2026-10-02-a-question-leaves-the-board-design.md`

This is the agentpod half of a two-repo change. superpipeline emits the facts — a
board's name, and an `elicitation.pending` event. This spec covers what the hub does
with them: name the board's room after the board, and put an agent's blocking question
in that room so it can be answered with a tap instead of a browser.

## The two problems

**1. Every board room is named "superpipeline".**
`services/matrix-as/board-room.ts` hardcodes it:

```ts
name: "superpipeline",
topic: `Approvals for board ${boardId}. Answer here and the board hears it.`,
```

Four live rooms carry that name, and the topic shows a raw `brd_…` id. The hub had no
alternative — it never learned a board's name — so the hardcoding was honest when it
was written and is now just wrong. The companion spec supplies `boardName`.

The *speaker* stays `superpipeline` (`BOARD_SPEAKER_DISPLAY_NAME`). That is the product
talking, and it is correct; the room name is the thing a person reads in a room list.

**2. A gate is answerable from a phone; an agent's question is not.** The gate pipeline
is proven end to end: push → a card in the board room → a tap read inbound → the hub
calls superpipeline **as the human** with a minted principal assertion → a sweep settles
the card if it was decided elsewhere. An elicitation has none of that, so every
permission prompt means opening the web app.

A board room, not a station room, is where this belongs, and the reason is already
settled: `charter → decisions/2026-09-28-a-gate-belongs-to-its-board-not-to-an-agents-room.md`.
A station room is spoken by a harness-mode agent that owns its own keys — this hub must
never encrypt as it, and correctly refuses to decrypt for it, so the question would be
delivered and the answer discarded unread. That exact failure was observed on
2026-09-28. A board room's keys are the hub's own, which is the only arrangement where
both halves work.

## Scope

In: naming board rooms after their board (including the four that exist); projecting
`elicitation.pending` into the board room; answering it from the room; a sweep.

Out: free-text answers — **buttons only**, decided with the operator on 2026-10-02.
Out: station-room projection, any change to gate behaviour, and any change to how the
hub mints principal assertions.

## Global constraints

- **Additive on the wire, both directions.** The hub and the board deploy separately.
  A `gate.pending` without `boardName` must still produce a room; an
  `elicitation.pending` this build does not understand must be answered `200 ignored`,
  because a non-2xx makes the board retry something it will never like.
- **Product vocabulary only.** No local workspace or agent names anywhere in shipped
  code, comments, fixtures or docs. The product word is *workspace*.
- **Exactly once into the room.** A redelivered push must not post twice. The existing
  pattern is the claim-before-send insert, not a record-after-send.
- **The hub never answers for a person.** Every call into superpipeline is made as a
  human principal via a minted assertion. An agent half and a human half held by one
  party would make every "a human decided this" record unprovable.
- The hub does not auto-deploy: `git -C /opt/agentpod pull && systemctl restart agentpod-hub`.

## Design

### 1. A room named after its board

**New on the Matrix client:** `setRoomName(asUserId, roomId, name)` — a `PUT` of
`m.room.name`. There is no `m.room.name` writer in `client.ts` today; `setAvatar` and
`enableRoomEncryption` are the shape to follow, including `assertOkOrAlready` and the
warn-but-do-not-throw handling, because a room that cannot be renamed is still a room
that works.

**`ensureBoardRoom` takes the name and re-asserts it.** `BoardRoomDeps` gains
`setName`, and the function gains a `boardName?: string` input. Both pushes carry it —
`gate.pending` and `elicitation.pending` — so either path can name the room, and
whichever arrives first does. That is why the field is threaded into `ensureBoardRoom`
rather than read at the gate's call site only.

The input is used as follows:

- On create: `name: boardName ?? boardId`, topic
  `Approvals for ${boardName ?? boardId}. Answer here and the board hears it.`
- On every subsequent hit, where it already re-checks membership for the same reason:
  call `setName` when the name differs from what was last set.

Re-asserting on every hit is what makes this **self-backfilling**: the four existing
rooms get their names on their next gate, with no migration. The fallback to `boardId`
is load-bearing — a hub newer than its board sees no `boardName` and must not rename a
correctly-named room to `undefined`.

**Store what was set.** `matrix_board_rooms` gains `name TEXT`, so "differs from what we
set" is a local comparison rather than a homeserver read on every gate. Null means
never set, which is every existing row.

**The four live rooms are renamed directly**, once, rather than waiting for a gate. The
operator asked for them renamed; a cosmetic fix that lands on the next approval is not
the fix they asked for.

### 2. An elicitation in the room

**A new content key**, beside the gate's:

```
dev.superpipeline.elicitation
```

Not a reuse of `dev.superpipeline.gate` — a gate's `options[].id` is a closed enum of
`approve | request_changes | reject`, and an elicitation's options are whatever the
agent offered. Not a reuse of `dev.agentpod.permission` either, however tempting: that
payload is addressed by ACP `session_id` + `request_seq`, which is how `answerPermission`
finds its request. An elicitation is addressed by `elicitationId` at superpipeline.
Borrowing the key would mean lying about the addressing in the one field a reader
trusts.

```ts
export const ELICITATION_REQUEST_CONTENT_KEY = "dev.superpipeline.elicitation";

export const ElicitationRequestCard = z.object({
  schema_version: z.number().int().min(1),
  board_id: z.string(),
  card_id: z.string(),
  elicitation_id: z.string().min(1),
  run_id: z.string(),
  stage_key: z.string(),
  card_title: z.string(),
  asked_by: z.string(),          // the agent that is blocked
  prompt: z.string(),            // the question; the carrying message has it too
  options: z.array(z.object({ id: z.string(), label: z.string() })).max(4),
  deep_link: z.string().optional(),
});
```

**Carried inside the prose message**, under that key, exactly as the gate is: the
`m.room.message` body stays the readable fallback every Matrix client shows, and a
client that knows the key draws buttons instead. `schema_version` is a floor — a
renderer tolerates a higher minor by ignoring what it does not know.

**The four-option cap, and why the prose is not capped.** supermessage renders four
buttons and silently drops the rest (`DECISION_MAX_OPTIONS`), which
`PermissionRequestEvent` already documents. An elicitation's agent may offer more. So
the structured card carries at most four, the prose lists **every** option numbered, and
when options were dropped the prose says so. The cap is applied where it can still be
reported rather than where it can only be lost.

**This works before any supermessage release.** The answer is an ordinary room message
carrying an option's number or name, matched by the existing pure
`matchPermissionAnswer(reply, options)` — so the question is answerable from any Matrix
client the day the hub ships, by replying `1`. Buttons arrive when supermessage learns
the key, which is a separate release the operator batches. Nothing in this spec waits
on iOS.

**An elicitation with no options** is posted as prose that names where it can be
answered, and no card. Buttons-only was the decision; pretending a question is tappable
when it is not would be worse than sending the operator to the web app for it.

### 3. Exactly once, and what was said

`matrix_elicitation_events`, mirroring `matrix_gate_events` field for field:

```
elicitation_id   TEXT PRIMARY KEY
tenant_id        TEXT NOT NULL → tenants(id) ON DELETE RESTRICT
board_id         TEXT NOT NULL      -- needed to address the answer endpoint
card_id          TEXT NOT NULL
room_id          TEXT NOT NULL
event_id         TEXT NOT NULL      -- the message a reply references
outcome_posted_at TIMESTAMP         -- when we said the board accepted an answer
created_at       TIMESTAMP NOT NULL DEFAULT now()
```

with `UNIQUE(event_id)` and an index on `tenant_id`, for the reasons the gate table
gives: a reply arrives holding the event and needing the question, the sweep goes the
other way, and two questions projected onto one event would make the first
unanswerable.

`outcome_posted_at` is the claim that stops a second receipt — a double tap or a
re-sent appservice transaction must leave one line in the room, not two that read as
though the question were answered twice (the shape of agentpod#614).

**Claim before send**, as `projectGate` does and documents: the insert *is* the
projection, and `onConflictDoNothing` returning no row means another delivery got there
first and this one stops without posting.

### 4. Answering

Inbound reply in a board room → resolve to an elicitation by the referenced event →
`matchPermissionAnswer` → call superpipeline **as the replying human**:

```
POST /v1/boards/:boardId/elicitations/:elicitationId/answer
{ "option": "<the matched option's id>" }
```

with a minted principal assertion, via the same path `resolveGateAtSuperpipeline` uses.
That route is human-session-only by design, and the assertion is what satisfies it —
the same key already fits the gate route.

Refusals are reported, not retried, each by name:

| from superpipeline | in the room |
|---|---|
| `ELICITATION_NOT_FOUND` | the question is gone; say so |
| already `answered`/`cancelled` | "That was already answered — the board has it." |
| option not offered | the options again, via `unmatchedAnswerText` |
| asking agent refused | cannot happen on this path (we answer as a human), but surfaced if it does |
| network failure | distinguished from a refusal: a refusal is final, this is not, so the reader may press again |

A reply matching nothing gets the options back rather than a scolding, reusing
`unmatchedAnswerText`.

### 5. The sweep

The floor beneath push, mirroring `gate-sweep.ts`, and it does both halves:

- an elicitation in superpipeline's pending list that this hub never projected → post it
  (a dead-lettered push, or a board whose config predates the event)
- an elicitation this hub projected that is **absent** from that list → it was answered
  in the web app, or superseded by a newer question, so settle the room card

The second half is the one that was missing for gates until it was added, and
supersession makes it matter more here than it does for gates: `openElicitation` retires
the previous question on the same card, so a room can hold a card for a question nobody
can answer any more. Settling it is not cosmetic — a stale tappable question is a
question that will be tapped.

## Testing

Pure logic in testable modules, with the network and the DB at the edges — the pattern
the recent board work established.

**Naming (1)**
1. `boardName` present → the room is created with it; topic carries it.
2. `boardName` absent → falls back to `boardId`, and an existing correctly-named room is
   **not** renamed to anything. (The regression that matters: a newer hub against an
   older board.)
3. Name unchanged → no `setRoomName` call. Name changed → exactly one.
4. `setRoomName` failing warns and the room still works.

**The card (2)**
5. Five options → the card carries four, the prose numbers all five and says some have
   no button.
6. Zero options → prose only, no card, and the prose says where to answer.
7. `matchPermissionAnswer` resolves by number, by label and by id, and returns null for
   anything else. (Pure; no Matrix.)

**Exactly once (3)**
8. The same `elicitation.pending` delivered twice posts once.
9. Two questions cannot project onto one event id.
10. A second reply after an outcome was posted leaves one receipt, not two.

**Answering (4)**
11. A matched reply calls the answer endpoint with the matched option id, as the human.
12. Each refusal above produces its own message in the room, and a network failure is
    distinguished from a refusal.

**The sweep (5)**
13. Pending at superpipeline, never projected → projected.
14. Projected, absent from pending → settled.
15. Projected and still pending → untouched. (The test that stops the sweep from
    re-posting every question on every pass.)

Every test must be watched failing first. Mutation-check the ones that pass on first
write — on this surface that discipline has already caught an hourly ceiling that never
fired and a setter with no caller.

## Rollout

1. Ship the contract key and the hub change; CI green; merge.
2. `git -C /opt/agentpod pull && systemctl restart agentpod-hub` — the hub does not
   auto-deploy, and this is the step that has been forgotten before.
3. Rename the four live board rooms (§1).
4. Add `elicitation.pending` to each board's push config. Not blocking: the sweep serves
   boards whose config has not been updated, just later.
5. supermessage learns `dev.superpipeline.elicitation` to draw buttons — a separate
   release the operator batches. Text answers work without it.

## What this does not do

- No free-text answers, by decision.
- No projection into station rooms; the 2026-09-28 decision stands.
- No board-rename event; a room's name converges on the board's next gate, by the
  companion spec's design.
- Nothing for the seven plaintext canary station rooms — unrelated, and still open.
