# Operations digest — design

**Status:** approved 2026-10-13. Operator decisions recorded in §3.

## 1. The problem

The fleet produces work, parks it, and waits. Nothing assembles what is waiting
into one place, so a question put to the operator is found only when the operator
goes looking. On 2026-10-13 three questions from the 2026-10-07 fleet-autonomy
plan had been open for six days, and the whole marketing publishing chain —
four cards — had been frozen since 10-09 behind a single missing permission.
Neither fact announced itself.

This is item 6 of the fleet-autonomy plan: *a daily digest of runs, parked cards,
halted loops and pull requests waiting for review, posted once to Matrix and
ntfy.* This design adds one thing to that brief: **the digest leads with
decisions awaiting the operator, oldest first.**

## 2. Where it lives, and why

**The agentpod hub**, as a scheduled job beside `gate-sweep` and
`elicitation-sweep`.

The hub already has every hard part: it posts encrypted messages into Matrix
rooms (`services/matrix-as/crypto-send.ts`), creates encrypted rooms
(`client.ts`), runs sweep-shaped scheduled jobs, holds the `bridge_dispatches`
ledger of runs and halted loops, holds the roster that enumerates which boards
this hub works, and reads superpipeline per board with the bridge's own token
(`pendingGates()`, `pendingElicitations()`).

Two alternatives were rejected. The **superpipeline worker** already has a
five-minute cron and owns cards natively, but it cannot send Matrix messages and
cannot see the bridge ledger — the two hardest pieces — so it would have to call
back into agentpod for both. A **script on foundry** would be a host cron rather
than part of the product, and could not reuse the hub's Matrix identity.

## 3. Operator decisions

| Decision | Choice |
|---|---|
| Destination | A new dedicated Operations room, created encrypted by the hub |
| Pull requests | **Forge only** in v1. Behind a source interface, so GitHub is a later addition, not a rewrite |
| Cadence | **Twice daily, 08:00 and 21:00 IST** (02:30 and 15:30 UTC) |

A consequence of forge-only, accepted knowingly: agentpod is GitHub-primary, so
its open pull requests do not appear in v1.

## 4. What it reports

Four sections, in this order. Every item carries its age in days, and every
section is sorted oldest first.

1. **Decisions awaiting you** — pending gates, pending elicitations, cards in a
   human-owned stage, and cards blocked with a `needsHuman` reason.
2. **Forge pull requests awaiting review** — open pull requests across the forge
   organization.
3. **Since the last digest** — runs completed and failed, cards advanced. The
   window is from the previous successful send recorded in `digest_sends`; on the
   very first run, and after a skipped slot, it is the preceding 12 hours.
4. **Attention** — halted bridge loops, cards parked at the circuit breaker, and
   **boards that could not be read**.

### Archived cards are excluded

`supi board` lists archived cards with no marker. On 2026-10-13 this made the
boards read as three times worse than they were: of 26 non-complete cards, 15
were archived, and seven of those carried a blocked reason that was correct for
an archived card and alarming out of context. The digest filters on
`archivedAt`, and says how many it excluded.

### A board that cannot be read is reported, never omitted

`elicitation-sweep.ts` states the rule this inherits: *"failing to read a board
can never be treated as 'nothing is pending'"*. A read failure is content — it
appears in **Attention** naming the board and the error class. A digest that
silently drops an unreadable board reports calm it has not verified, which is
the failure mode that let the Matrix backups report success for 21 nights while
writing nothing.

## 5. Scheduling, and surviving a restart

A one-minute tick, not an interval timer, because the slots are clock times.

A slot is due when the current time is at or past it and no successful send is
recorded for that slot. Sends are recorded in a new table, `digest_sends`, keyed
on `(slot_date, slot)` — so:

- a restart cannot double-send a slot;
- a hub that was down at 08:00 and up at 08:40 still sends, marked **late**;
- a hub down across a whole slot skips it rather than sending two at once.

**The record is written only after the Matrix send is confirmed.** A send that
throws, or that the homeserver does not acknowledge, leaves the slot due and is
retried on the next tick. After **five** attempts — the count elicitation
delivery already uses before dead-lettering — the slot is abandoned with an
error log naming it, and the next slot proceeds normally. Recording an unverified send would reproduce the backup
bug exactly.

## 6. Delivery

- **Matrix:** one encrypted message into the Operations room, via the existing
  `crypto-send` path. The room is created on first use with an alias, encrypted
  at creation, following `client.ts`.
- **ntfy:** one line — counts per section — plus a link to the room. The hub has
  no ntfy wiring today, so this is new configuration.

The digest carries **no decision actions**. Per charter, only a human decides a
gate, and a gate belongs to its board; the digest points at gates and never
offers to settle one. Gates and questions stay answerable where they already
are, including by replying with a number in their own room.

## 7. What must never appear in the message

Card titles, ids, stage names, ages and counts only. Never a token, never a
card's `spec` body, never a run transcript, never an agent's reasoning. Card
specs in this estate carry repository URLs and access notes; the digest links to
the card instead of quoting it.

## 8. Operator prerequisites

1. A forge read token for the organization's pull requests, in hub config.
2. An ntfy base URL and topic.

Neither is needed for the digest to run: with no forge token §4.2 is omitted
with a line saying so, and with no ntfy config the Matrix post still happens.
The digest degrades by announcing the gap, never by going quiet.

## 9. Testing

- The renderer is pure: sections, ordering, ages, empty states and the excluded
  and unread counts, all against fixtures.
- Slot arithmetic across IST/UTC, including a slot missed by a restart, a slot
  already sent, and the day boundary.
- A send that fails leaves the slot due; a send that succeeds records exactly
  once. Revert-proof: break the ordering, the `archivedAt` filter, or the unread
  reporting, and a named test must fail.
- Integration: a board whose read throws appears in **Attention** and does not
  suppress the other boards.

## 10. Out of scope

GitHub pull requests; per-board or per-agent digests; a console view; any
digest-driven action on a card; cost reporting; and a weekly rollup.
