# Approvals over chat — implementation design

**Date:** 2026-08-30
**Status:** Designed, unbuilt.
**The agreement this implements** is `charter → decisions/2026-08-30-a-gate-closes-over-chat.md`.
Read it first. It settles the emitter, the namespace, the return path, the room
and the delivery semantics, and it records the costs. This document holds only
what that one deliberately does not: what changes in which repository, in what
order, and how it is tested.

**Why it is here and not in charter.** charter's README rules out roadmaps
written in the present tense and per-product detail. This is both. The estate was
moved out of that repository on 2026-08-29 for a weaker version of the same
reason.

---

## 1. The shape

```
kaambaan                              AgentPod hub              supermessage
────────                              ────────────              ────────────
card enters approval stage
  gates row opens
  notify('gate', …)      ── exists ──▶ (in-app only today)

  queue gate.pending     ── NEW ──┐
  HMAC-sign, POST        ─────────┘──▶ POST /api/bridge/kaambaan/push   NEW
                                         verify X-Kaambaan-Signature
                                         dedupe on gate_id
                                         card → station → matrix_rooms
                                              │
                                       AS sends as @agent_guild_… ──▶ room
                                       record gate_id → event_id     NEW
                                                                          │
                                                       renderer registered  NEW
                                                       DecisionCard ← built
                                                                          │
                                                       [Approve] tapped
                                                       send_decision()    NEW FFI
                                                                          │
                                       PUT /_matrix/app/v1/              ◀┘
                                           transactions/:txnId  ── exists, idempotent
                                         sender mxid
                                           → principal_identities ── exists, populated
                                           → mint hub JWT (sub = human)
                                              │
POST /v1/boards/:id/gates/  ◀─────────────────┘
     :gateId/resolve  ── EXISTS
  accept hub token via resolveHubUser    NEW
  decided_by = the human's principal
```

Nine boxes; five already exist.

## 2. The order, and why it is this order

```
1. contract  ──▶  2. kaambaan  ──▶  3. hub  ──▶  4. supermessage
   fixture          outbound          projection    renderer + send
                                      ▲
                                 verify HERE in Element,
                                 before step 4 starts
```

The schema mandates a human-readable `body`, so **the whole outbound half is
verifiable in a stock Matrix client before any supermessage code is written.** If
the gate reads correctly in Element, the projection is right. That puts the
riskiest work — new FFI across two mobile platforms — last, and behind a contract
already proven on the wire.

## 3. charter — the contract

The fixture goes to **`agentpod/fixtures/ecosystem-identity/matrix_gate_events.json`**,
not to charter. charter's README is explicit that moving the corpus needs a sync
mechanism first and that a second copy would drift immediately; kaambaan does not
vendor the corpus today, it references it by path and reimplements by hand.
Adding a new fixture to charter would create exactly the drift the README names.

It pins both event types **with reject cases**. The corpus's own rule: a
valid-examples-only fixture proves almost nothing, and the `mem_`/`mbr_` drift is
the scar behind it. Reject at minimum:

- an `option_id` outside `{approve, request_changes, reject}`
- a decision whose `gate_id` disagrees with its `m.relates_to` target
- a gate event with no `body`
- a `tenant_id` field (dropped deliberately; its presence means a stale sender)
- `run_id` / `task_id` / `expires_at` (all dropped; see the decision)

## 4. kaambaan — 5 changes

1. **`gate.pending` push event.** With its **own fan-out rule**: a gate is
   addressed to the card's *owner*, so it must not copy `notifyWorkAvailable`'s
   capability match, which addresses whoever can claim the stage.
2. **Retry in the drain.** `push_deliveries` gains `attempts` and
   `next_attempt_at`; `dispatchPushDeliveries` re-picks failed rows with backoff
   to a cap. This is what turns at-most-once into at-least-once. Today a `failed`
   delivery is terminal, which for a gate means a card blocked forever on an
   approval that never rang.
3. **A pending-gates read**, for the hub's reconciliation sweep.
4. **Accept `resolveHubUser` on `POST /v1/boards/:id/gates/:gateId/resolve`.**
   The second route ever to take a hub token. `auth/resolve.ts` already
   anticipates this: *"this is the first endpoint to accept a hub token, and
   keeping the seam narrow means the blast radius of getting it wrong is one
   route instead of the whole surface. Widening it is a later, deliberate step."*
   This is that step, and it should stay deliberate — one route, not the surface.
5. **Move `GateDecision` into `packages/contract`.** It lives in `board-do.ts`
   today. It is now a cross-repo contract value and belongs where the contract is
   defined once.

## 5. AgentPod hub — 6 changes

1. **`POST /api/bridge/kaambaan/push`** — verifies `X-Kaambaan-Signature`
   (HMAC-SHA256 over the exact bytes). **Must be CSRF-exempt**: it is a signed
   webhook, not a browser POST, and the middleware skips only Bearer today.
2. **`matrix_gate_events`** — `gate_id` primary key → `event_id`, `room_id`,
   `board_id`, `created_at`. This one table is what makes a retry, a redelivery
   and a sweep all converge on **one** Matrix event per gate instead of three
   copies of the same question.
3. **Projection** — card → station → `matrix_rooms.room_id`, sent **as the
   station's own virtual user**. The AS already controls `@agent_.*` and that
   user is already in the room, so there is no membership change and no new room.
   A card no station ran has no room: log and skip. Named limitation.
4. **Reconciliation sweep** on a timer — which pending gates have no `event_id`?
   This is the floor beneath push.
5. **AS transaction handler** learns `dev.kaambaan.gate.decision.v1`: map sender
   via `principal_identities`, mint a hub JWT with `sub` = the principal, call
   the resolution endpoint. Every refusal in §6 of the decision lives here.
6. **Register the push config** with kaambaan, and script it so a rebuild does
   not silently lose the subscription.

## 6. supermessage — 4 changes

1. **Register the `dev.kaambaan.gate.v1` renderer** in
   `crates/supermessage-core/src/custom_events.rs` — one `register` call. The
   module was built so that landing a schema *"is a `register` call rather than a
   refactor"*, and this is the first time that claim is tested.
2. **New FFI `send_decision(room_id, gate_id, option_id, comment, in_reply_to)`.**
   The FFI exposes `send_message` and `send_reply` only; there is no path to send
   a typed event today.
3. **Wire the button on iOS and Android.** `DecisionCard.swift` already has
   `option.id` at the call site, unwired with a comment saying it cannot
   attribute the decision. It can now.
4. **Prompt for a comment on `request_changes` only.** Approve and reject are
   decisions; request-changes is feedback that becomes the rework's context.

The 8 KiB content cap, 12 fields, 300 chars per value and 60 per label are
already enforced in the core and the schema fits inside them.

## 7. Tests

**Contract.** Fixture round-trip in each repo — the mechanism already keeping
five hand-written Go mirrors of zod schemas honest with no drift
(`apps/node-agent/internal/contractfix/`), aimed across a repo boundary.

**kaambaan.** A gate opening queues a delivery; the fan-out is owner-addressed
and not capability-addressed; a failed delivery retries with backoff and stops at
the cap; a hub token is accepted on the resolve route and on no other; existing
separation-of-duties behaviour is unchanged.

**hub.** A bad HMAC is refused; the same `gate_id` delivered twice produces one
event; a sender with no `principal_identities` row is refused and nothing
resolves; an `option_id` outside the enum is refused before any network call;
events from the AS's own namespace are ignored.

**supermessage.** A renderer test in the shape `DecisionCardTest.kt` already has;
a malformed payload degrades to `body` rather than a placeholder.

**The exit test, as an assertion rather than a feeling.** A real card on a real
board blocks on approval; the gate arrives on the phone; Approve is tapped; the
card advances; and `gates.decided_by` reads the human's principal id — **not the
bridge's**. That is the failure
`charter → decisions/2026-08-14-approvals-cross-planes-as-events.md` exists to
prevent, and it is the only thing this slice must prove.

## 8. Explicitly not in this slice

- The three other event types from kaambaan#34 — `card`, `run`, `agent.status`.
  Nothing is blocked on them, and two carry open questions the decision does not
  answer (whether metering data should cross into a room, and whether agent
  status belongs in a conversation at all).
- A fallback room for gates on cards no station ran.
- The Queue → Workflow durable-transport upgrade.
- MT-1 through MT-4. Real work; not this chain.
