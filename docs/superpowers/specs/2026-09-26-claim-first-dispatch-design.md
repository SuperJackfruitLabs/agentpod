# A card becomes a turn by being claimed first, not by being pushed

**Status:** accepted 2026-09-26. Supersedes the push-dispatch sketch discussed the same day.

**Depends on:** `2026-09-25-harness-error-standard-design.md`. Not a preference — see
[The dependency that is not optional](#the-dependency-that-is-not-optional).

**Companion:** superpipeline registers the push config (small, config-level). Everything else is
here.

## What this is for

Guild agents doing real work as a team on a superpipeline board: a card moves through
`Brief → Draft → Verify → Publish`, a different agent holds each stage, and a human answers two
gates. The first board is **Press** — publishing the SJL blog from `sjl-marketing` content to
`super-jackfruit-website` — chosen because a bad outcome is a revertible commit on a site nobody
depends on.

This document covers exactly one question: **how a card entering a stage becomes a harness turn on
a station, and how that turn's life and death are accounted for.** Board design, agent
assignment and gate placement are settled elsewhere.

## The decision

**A claim-first dispatcher in the hub.** One logical worker per (board, agent). It wakes, claims a
run, starts exactly one ACP session to execute it, heartbeats while that session lives, and never
asserts success.

```
work.available (push)  ─┐
                        ├─▶  wake  ─▶  claim  ─▶  session  ─▶  turn  ─▶  agent completes
periodic tick  ─────────┘              │                        │
                                       │                        └─ hub heartbeats while alive
                                       └─ lost the race? nothing dispatched, nothing spent
```

## Why claim-first, and not push-dispatch

The sketch this replaces had the push start a turn, and the turn then claim. It needed run-keyed
dedup (because delivery is at-least-once) and an independent sweep (because delivery gives up after
five attempts). Both were mechanisms invented to make delivery load-bearing.

Delivery must not be load-bearing, and superpipeline already says so:

> Pull is the default; push is an **accelerator** that just tells an agent to call `claim`.
> — `superpipeline/docs/05-integration-surfaces.md` §4

`claim` is the contract's own critical verb, with lease epochs and exactly one winner. It is
already the idempotency barrier. Building on it deletes the dedup table and the sweep, because a
duplicated wake-up loses a claim race harmlessly and a lost wake-up is picked up by the next tick.

The obstruction was that harness agents cannot poll — they are turn-based, invoked rather than
running. But **nothing requires the harness to be the puller.** The hub is a service and the
node-agent is a daemon. So the hub pulls, and a harness turn stops being the thing that decides to
work and becomes the execution of a run already claimed.

Push is kept, and is worth keeping: it buys latency. Losing it costs seconds, never a stalled card.

## The invariants

These are the whole of the correctness argument. Each is stated so a test can fail on it.

1. **No turn without a claim.** Spend follows authority, never the reverse. A refused control pair
   or a lost race costs an HTTP call, not an LLM turn.
2. **One claim per station at a time — counted per station, not per worker.** A station runs one
   ACP session (`acp.isBusy`), so it may hold at most one run. The bound is the *station's*, which
   matters because an agent staffed on two boards has two workers: without this, each could win a
   claim and the second turn would have nowhere to run, leaving a claimed run that cannot start and
   will only end by heartbeat lapse. A worker must therefore check the station, not its own state,
   before claiming. This enforces superpipeline's agent claim ceiling *by construction* rather than
   by a second mechanism that could disagree with the first.
3. **The hub never asserts success.** It may `fail` or `release`; only the agent may `complete`.
4. **One ACP session per Run, never per room.** A retry inherits nothing from the attempt it
   replaces.
5. **The board is the record.** Where the transcript and the board disagree, the board wins.

## Session per run, not per room

`dispatchTurn` (`apps/hub/src/services/matrix-as/inbound.ts`) keeps one session per Matrix room,
deliberately:

> One session per room, not per message: a conversation is a conversation, and a session per
> message would throw away the agent's context between two consecutive sentences.

That reasoning is correct and does not transfer. superpipeline's **Run** is "one attempt to execute
a card's stage work by one agent". An attempt is precisely the unit whose context must not leak
into the next attempt: a run reclaimed for being wedged must not hand its confusion to its
replacement.

So the card-triggered path takes a session keyed by run id. This is the change that decouples
dispatch from `RoomRow`, and it is the bulk of the work.

## Who heartbeats, and why it is the hub

The claim TTL is **15 minutes with no heartbeat**, and the contract is blunt that this is the only
liveness rule that exists:

> Heartbeat more often than every 15 minutes and treat that as the only liveness rule that exists.

A healthy harness turn can exceed fifteen minutes, and an agent mid-LLM-call cannot heartbeat. The
hub can observe whether the ACP session is alive — which is exactly the claim a heartbeat makes. So
the hub heartbeats on the run's behalf while the session lives, and stops the moment the harness
reports the turn ended.

**This is the one place the design can lie.** A hub that heartbeats a wedged turn keeps a dead card
alive forever, and the enforced backstop — two consecutive reclaimed runs auto-block the card into
`input-required` for a human — never trips, because nothing is ever reclaimed. That is the only
path by which a card can be lost in silence, and it is closed by the harness error standard and by
nothing else.

## What the turn is told

Card id, stage key, run id. Nothing else.

The agent reads the card, its handoff `metadata` and its references from the board, with its own
`spa_` token. A prompt that carried the work would be a copy, and after a reclaim it would describe
a run the agent no longer holds. The message is a nudge; the board is the record. This is the same
stance §4 takes when it calls push "an accelerator that just tells an agent to call `claim`".

## Where the stream goes

Into the board's room in supermessage, per the room-per-board revision of
`charter → decisions/2026-08-30-a-gate-closes-over-chat.md`. `deps.attach` needs a room, and the
station's own room is the wrong one: with three agents on one card, "the room where the work
happened" no longer names a single place.

Three surfaces, three jobs, and this is the whole of the notification discipline:

| Surface | Carries | Interrupts a human |
|---|---|---|
| superpipeline card | typed activity, attempts, handoffs, cost | no — you visit it |
| Board room | the live turn stream | no — you read it when you care |
| Gates and elicitations | a decision only a human can make | **yes**, as `m.notice` |

## The actor column

`dispatchTurn` records `acp_sessions.user_id` as the station's **owner**, and the code already
names the cost:

> The cost, recorded rather than hidden: `acp_sessions.user_id` now names the owner, so a
> transcript no longer says WHICH principal asked. That needs its own column, not this one doing
> two jobs.

For a human in a room that is a wart. For card work it is a correctness problem: the asker is the
board acting for the card's **owner**, while the executor is the **delegate**. superpipeline models
that distinction properly and bills against it. A session table that cannot express it produces
cost and audit trails that are wrong, not merely vague.

So this adds the column the comment asks for, rather than inheriting the ambiguity into a surface
where money is spent on a human's behalf.

## The dependency that is not optional

`2026-09-25-harness-error-standard-design.md` ships first. The heartbeat in step 4 stops "the
moment the harness reports the turn ended", and that report is what the error standard builds —
OpenClaw's `agent_end` and Pi's `message_end` currently drop the reason, which is why a failed turn
can present as silence.

Order of work:

1. The harness error standard, trialled on `krishna`.
2. The actor column — independent of the rest, and cheap while the schema is open.
3. Claim-first dispatch: the worker loop, the per-run session, the `work.available` branch on the
   existing bridge endpoint.
4. superpipeline: register the push config, capabilities matching the stage tags.

## What this costs

- **A hub that is now a work scheduler.** It was a gateway and a registry; it gains a loop with
  money attached to it. That is a real widening of what the hub is for, and it is deliberate: the
  alternative put the loop in N nodes, where the claim ceiling would be enforced N times and agree
  only by luck.
- **The hub is a single point for dispatch.** Acceptable because a node reaches the fleet only
  through the hub, so a hub outage already stops work; this adds no new failure mode. It is worth
  remembering that the hub is deployed **by hand** (`/opt/agentpod`, `systemctl restart
  agentpod-hub`) and does not follow `main`.
- **A turn can outlive the card's patience.** Nothing enforces a per-stage maximum runtime —
  `StageDef` has no `maxRuntime` and the contract marks it not built. A pathological turn is bounded
  only by the harness, not by the board.

## What this does not do

- **No self-directed work.** The board is filled by a human; `Commission` is a queue nobody
  polls. Agents choosing their own work is a later stage and a separate decision.
- **No gate removal.** Both human gates stay on for the first board. They are stage properties, so
  turning them off later is configuration, not a rewrite.
- **No branch reconciliation.** What a reclaimed run does about a half-written branch and an open
  PR is the one failure mode the board's state machine cannot reason about, and it is the next
  document, not this one.
- **No second board.** Pointing this at supermd needs a Rust/GPUI skills profile that does not
  exist, and supermd is the hardest codebase in the estate to verify an agent's work in.

## Testing

The invariants above, each as a failing test first:

- A wake with no claimable card starts **no session** — asserted on the ACP layer, not on a log line.
- Two simultaneous wakes for one card produce **one** claim and one session.
- A station already busy claims **nothing**.
- A hub that observes a turn end **stops heartbeating**, and the run is reclaimed on schedule.
- A turn that dies without completing leaves the run reclaimable; two of them block the card into
  `input-required`.
- The hub has **no code path that calls `complete`** — asserted structurally, the way
  `cmd/agentpod-fleet`'s tests assert the absence of node verbs.
- A prompt carries card id, stage key and run id, and **not** the card body.

Live verification before the issue closes, per `CLAUDE.md`: one real card through
`Brief → Draft → Verify → Publish` on the Press board, against the deployed hub, with the PR it
produces linked from the card as a reference.
