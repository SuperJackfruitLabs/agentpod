# Approvals over chat — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A kaambaan approval gate reaches a phone as a Matrix message, and the
human's tap resolves it on the board as *that human*.

**Architecture:** kaambaan queues a signed `gate.pending` webhook; AgentPod's
Application Service verifies it, projects the gate into the station's DM room as
the station's own virtual user, and records `gate_id → event_id` so one gate is
one message. The human's reply is a typed `m.room.message`; the AS maps the
sender through `principal_identities`, mints a hub JWT with the human as `sub`,
and calls kaambaan's existing gate-resolution endpoint.

**Tech Stack:** Cloudflare Workers + D1 + Durable Objects (kaambaan); Bun + Hono
+ Drizzle + Postgres (hub); Rust + UniFFI + SwiftUI/Compose (supermessage).

**Spec:** `docs/superpowers/specs/2026-08-30-approvals-over-chat-design.md`
**Agreement:** `charter/decisions/2026-08-30-a-gate-closes-over-chat.md`

## Global Constraints

- **The wire event type is `dev.kaambaan.gate.v1`** — a genuine custom event
  type, matching the three `dev.agentpod.*` types already shipping.
- **Fallback is a companion prose `m.room.message` sent beside it**, which is the
  suite's existing convention, not a new mechanism: `PermissionRequestRenderer`
  documents it as the reason a client that never renders the custom event is
  *"exactly as able to answer as it was"*. Stock clients read the prose; the
  buttons are supermessage's. No further work is spent on Element parity.
- **`item_view.rs` is not touched.** The registry dispatches on event type, as built.
- **supermessage leads.** It depends only on the fixture, so nothing blocks it.
  Order: charter → fixture → supermessage → hub → kaambaan.
- **Option ids are exactly `approve | request_changes | reject`.** kaambaan's
  `GateDecision`. Labels are free text.
- **The AS resolves nothing it cannot attribute.** No `principal_identities` row
  for the sender ⇒ refuse, log, resolve nothing.
- **One gate ⇒ one Matrix event**, enforced by `gate_id` primary key.
- **Never merge to `main`.** Each repo gets a branch and a PR.
- **Stale docs are corrected in the PR that found them**, not tracked separately.

---

## Task 1 — charter: commit the agreement, corrected

**Files:** Modify `charter/decisions/2026-08-30-a-gate-closes-over-chat.md`
**Branch:** `decision/a-gate-closes-over-chat`

- [ ] Amend decision 3 for the `m.room.message` + marker shape and state plainly
      that #34's fallback premise was wrong about event types.
- [ ] Commit and open a PR.

## Task 2 — agentpod: the fixture corpus

**Files:** Create `agentpod/fixtures/ecosystem-identity/matrix_gate_events.json`;
modify `agentpod/fixtures/ecosystem-identity/README.md`
**Test:** `agentpod/packages/contract/src/matrix-gate-events.test.ts`

**Produces:** the accept/reject corpus both other repos validate against.

- [ ] Write the fixture: both event shapes, `accept` and `reject` arrays.
      Reject at minimum — option id outside the enum; `gate_id` disagreeing with
      the `m.relates_to` target; missing `body`; a `tenant_id` field; `run_id`,
      `task_id` or `expires_at` (all dropped deliberately).
- [ ] Write the round-trip test; run it; it fails.
- [ ] Add validators in `packages/contract`; run; passes.
- [ ] Commit.

## Task 3 — kaambaan: `gate.pending`, the drain, and the stale doc

**Files:** Modify `apps/api/src/board/board-do.ts`,
`apps/api/docs/05-integration-surfaces.md`
**Test:** `apps/api/test/gate-push.test.ts`
**Branch:** `feat/gate-pending-push`

**Consumes:** the fixture from Task 2.
**Produces:** `gate.pending` delivery body
`{ event, boardId, cardId, gateId, stageKey, returnStageKey, cardTitle, producedBy, prompt, options, ts }`.

- [ ] Test: opening a gate queues one delivery per config subscribed to
      `gate.pending`, and **none** for a config subscribed only to
      `work.available`. Run; fails.
- [ ] `notifyGatePending(gateId)` beside `notifyWorkAvailable`, called from the
      gate-opening path. Fan-out is **subscription-only** — a gate belongs to the
      card's owner, so it must not copy `work.available`'s capability match.
- [ ] Test: queuing schedules a DO alarm, and the alarm drains. Run; fails.
- [ ] Drain from `alarm()`. This is the real gap: nothing drove the queue.
- [ ] Correct `docs/05 §4` — retry, the 5-attempt cap and dead-lettering are
      built; the "at-most-once, terminal failure" text is wrong. Record what is
      actually missing (nothing drains without a poke — now fixed).
- [ ] Run the full suite; commit.

## Task 4 — kaambaan: hub tokens on the gate resolver

**Files:** Modify `apps/api/src/index.ts`, `apps/api/src/auth/resolve.ts`,
`apps/api/src/board/board-do.ts` (move `GateDecision`),
`packages/contract/src/index.ts`
**Test:** `apps/api/test/gate-resolve-hub-token.test.ts`

- [ ] Test: a valid hub token resolves a gate and `decided_by` is the token's
      `sub`; an unmapped tenant is refused; the token works on **this route and
      no other**. Run; fails.
- [ ] Widen `resolveHubUser` to the gate-resolution route only. Keep the seam
      narrow — one more route, not a middleware over the surface.
- [ ] Move `GateDecision` into `packages/contract`; re-export from `board-do.ts`
      so nothing else changes.
- [ ] Run suite; commit; open PR.

## Task 5 — hub: the push receiver and the gate-event record

**Files:** Create `apps/hub/src/routes/kaambaan-push.ts`,
`apps/hub/src/db/schema/gate-events.ts`,
`apps/hub/src/db/drizzle-migrations/0053_matrix_gate_events.sql`;
modify `apps/hub/src/index.ts`
**Test:** `apps/hub/src/routes/kaambaan-push.test.ts`
**Branch:** `feat/approvals-over-chat`

**Consumes:** Task 3's delivery body.
**Produces:** `matrixGateEvents` table — `gateId` PK, `eventId`, `roomId`,
`boardId`, `cardId`, `createdAt`.

- [ ] Test: a body with a bad `X-Kaambaan-Signature` is refused 401 and nothing
      is written; a good one is accepted. Run; fails.
- [ ] Migration + schema + route. HMAC-SHA256 over the exact bytes, compared in
      constant time. **CSRF-exempt** — it is a signed webhook, not a browser POST.
- [ ] Test: the same `gateId` delivered twice produces one row and one send.
- [ ] Commit.

## Task 6 — hub: the projection

**Files:** Create `apps/hub/src/services/matrix-as/gates.ts`;
modify `apps/hub/src/services/matrix-as/index.ts`
**Test:** `apps/hub/src/services/matrix-as/gates.test.ts`

**Consumes:** Task 5's table. **Produces:** `projectGate(delivery, deps)`.

- [ ] Test: a delivery for a card whose station has a room sends one
      `dev.kaambaan.gate.v1` event with a `body` naming the card and stage, and
      the three options. Run; fails.
- [ ] Implement: card → station → `matrix_rooms.room_id`; send via
      `sendCustomEvent` as the station's own virtual user.
- [ ] Test: a card with no station room writes no row and sends nothing — the
      named limitation, asserted so it stays deliberate.
- [ ] Commit.

## Task 7 — hub: the inbound decision

**Files:** Modify `apps/hub/src/services/matrix-as/inbound.ts`,
`apps/hub/src/services/matrix-as/gates.ts`
**Test:** `apps/hub/src/services/matrix-as/gate-decision.test.ts`

- [ ] Test the refusals, one assertion each: no `principal_identities` row;
      `gate_id` disagreeing with the `m.relates_to` target; an `option_id`
      outside the enum. Each resolves nothing. Run; fails.
- [ ] Implement: recognise event type `dev.kaambaan.gate.decision.v1`, map sender → principal, mint a hub JWT
      with `sub` = principal, POST the resolution.
- [ ] Test: a 409 `GATE_NOT_PENDING` posts a follow-up in the room rather than
      failing silently.
- [ ] Commit.

## Task 8 — hub: the reconciliation sweep

**Files:** Create `apps/hub/src/services/matrix-as/gate-sweep.ts`
**Test:** `apps/hub/src/services/matrix-as/gate-sweep.test.ts`

- [ ] Test: a gate pending at kaambaan with no `matrix_gate_events` row is
      projected; one with a row is not re-sent. Run; fails.
- [ ] Implement + schedule. This is the floor beneath push.
- [ ] Commit; open PR.

## Task 9 — supermessage: the gate renderer

**Files:** Modify `crates/supermessage-core/src/custom_events.rs`
**Test:** in-file `#[cfg(test)]`

- [ ] Test: a `gate.v1` payload renders a decision with the prompt and three
      options; a payload with an option id outside the enum renders **no**
      decision. Run; fails.
- [ ] Register the renderer. One `register` call, as the module was built for.
- [ ] Commit.

## Task 10 — supermessage: send the decision

**Files:** Modify `crates/supermessage-core/src/timeline.rs`,
`crates/supermessage-ffi/src/lib.rs`
**Test:** in-file `#[cfg(test)]`

**Produces:** `send_decision(room_id, gate_id, option_id, comment, in_reply_to)`.

- [ ] Test: it builds content with `gate_id`, `option_id`,
      `m.relates_to` reference and a `body`; it refuses an option id outside the
      enum. Run; fails.
- [ ] Implement in core, then expose through the FFI. **Route it through
      `self.block(...)`** like every other FFI call — see the 8 MB stack note.
- [ ] Commit.

## Task 11 — supermessage: wire the button

**Files:** Modify `apple/Supermessage/Timeline/DecisionCard.swift`,
`android/app/src/main/kotlin/dev/supermessage/DecisionCard.kt`

- [ ] Regenerate UniFFI bindings.
- [ ] Wire both buttons to `send_decision`; prompt for a comment on
      `request_changes` only.
- [ ] Build both; commit; open PR.

---

## Self-review

**Spec coverage.** Spec §3 → Task 2. §4.1–4.5 → Tasks 3, 4. §5.1–5.6 → Tasks 5,
6, 7, 8. §6.1–6.4 → Tasks 9, 10, 11. §7 tests are folded into each task.
Doc corrections → Tasks 1, 3.

**Gap found and closed:** the spec assumed retry needed building in kaambaan; it
exists. Task 3 replaces that with the defect actually found — nothing drains the
queue.

**Not in this plan, deliberately:** `card`/`run`/`agent.status` events; a
fallback room for gates on cards no station ran; the Queue → Workflow upgrade;
MT-1..MT-4.

**Device verification is not achievable unattended.** Task 11 ends at *compiles
and unit-tests pass*. An end-to-end tap on the phone needs a person holding it.
