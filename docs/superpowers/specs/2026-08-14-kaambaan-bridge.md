# The kaambaan bridge

**Date:** 2026-08-14 · **Status:** built, not yet run against a live board
**Replaces:** `apps/bridge/spike/`, deleted in the same change
**Earned by:** [the spike's findings](./2026-08-11-kaambaan-bridge-spike-findings.md)

The spike answered whether the seam holds. It does. This is the production
bridge, written test-first, and every requirement below traces to something the
spike **measured** rather than something it assumed.

---

## What it is

A process inside the hub — `apps/hub/src/services/bridge/` — that claims cards
from a kaambaan board and executes them as ACP sessions on stations.

One process multiplexing many agent identities, not a process per agent. The
hub already owns the station connections and the ACP session machinery; a
second process would need a copy of both. What is *not* shared is identity:
each loop holds its own `kbn_` token, because Decision 3 says an agent's
authority is its own rather than a projection of whoever dispatched it. "The
bridge's credential" is not a thing that exists.

| File | What it owns |
|---|---|
| `config.ts` | The gate, and the agent roster |
| `kaambaan.ts` | The agent-contract client, and the 403/409 distinction |
| `coalesce.ts` | ACP transcript → board activities, buffered to a boundary |
| `dispatch.ts` | One claim, worked start to finish |
| `ledger.ts` | The `acp_runs` join and the at-least-once ledger |
| `loop.ts` | Claim-and-lease loops, and the boot hook |

**Off by default.** `ENABLE_KAAMBAAN_BRIDGE` must be the literal string
`"true"`, exactly like `isProviderEnabled`, and nothing is inferred from a
token being present — a credential in an env file is not a decision to start
claiming work on someone's board. A hub that has not opted in constructs
nothing and behaves exactly as it does today.

---

## The prompt contract

**`card-prompt/1`**, in `packages/contract/src/card-prompt.ts`, with fixtures in
`fixtures/ecosystem-identity/card_prompt.json`.

This is the actual contract between the two planes and nothing wrote it down.
The spike sent `work.card.title` as the entire prompt — the spec, the previous
stage's handoff and every reference were dropped, and no test caught it because
every test asserted the seam *carried* the work rather than what the work said.
An agent given only a title does the wrong work confidently.

Its inputs are exactly what an agent token may read:
`GET /v1/boards/:boardId/runs/:runId` returns `{run, card, stage, handoff,
references}` and nothing else. So the contract is the whole agent-visible
surface, projected into text.

Four rules, each with a fixture:

1. **Sections are omitted, never rendered empty.** A heading with nothing under
   it tells a harness "there was nothing to do here", which is a different
   claim from "this was not provided".
2. **A non-string `spec` or `handoff` is fenced JSON.** kaambaan types both as
   `JsonValue`; a harness must never be shown `[object Object]`.
3. **`feedback` is lifted out of the handoff.** A `request_changes` gate merges
   it into the handoff the agent itself produced (kaambaan `board-do.ts:1505`);
   left in the blob, the reviewer's instruction is the least prominent sentence
   on the card.
4. **The attempt number is always stated.** Attempt 2 is not the same
   instruction as attempt 1, and a harness that cannot tell them apart cannot
   behave differently on a retry.

The corpus pins the **rendered text**, not just the shape — agreeing on a
schema and disagreeing on what it reads like is exactly the failure this is
meant to catch. A test also asserts no rendered prompt contains a `kbn_` token,
an `attempt_`/`acps_` id or a lease epoch: the text crosses into a harness
process and comes back in a transcript the board renders.

Versioned, and it refuses a version it cannot render. A `card-prompt/2` parsed
as v1 is how a section goes missing on one side of a seam with nobody noticing.

---

## 403 and 409

kaambaan checks run ownership **before** the lease (`board-do.ts:1746-1766`)
precisely so these stay apart. The bridge keeps them apart too, and classifies
on kaambaan's own error **code** rather than on status — 403 also carries
`SEPARATION_OF_DUTIES` and 409 also carries `GATE_NOT_PENDING`, and
status-only classification would call a gate conflict a lost lease and end a
healthy harness mid-run.

| | **409 `STALE_LEASE`** | **403 `NOT_RUN_OWNER`** |
|---|---|---|
| Means | the lease lapsed; the card is re-queued | this run is another agent's |
| ACP session | **ended** | **ended** |
| Attempt closed as | `canceled` | `failed` |
| Dispatch outcome | `abandoned`, reason names the lease | `abandoned`, reason names the other agent |
| Further verbs on the run | none | none |
| The agent's loop | **claims again** | **halts**, with a fault |

Ending the session is the spike's concrete deliverable. kaambaan fences its own
state — RQ4 came back with `leaseEpoch: 2` and the old run locked out of every
write — but nothing fences the machine, and the stranded harness kept editing
the workspace with no idea its lease was gone. In a task that outlives the
15-minute reclaim, two harnesses would be writing one directory while kaambaan
correctly ignored one of them.

Neither path sends `fail` or `release`. Both would 409, and both are an attempt
to write to a card somebody else now holds; a "tidy" cleanup call is the retry
loop this distinction exists to prevent.

The loop halts on 403 because an agent driving another agent's run is a bug in
configuration or in the bridge, and claiming again walks straight back into it.
A lost lease is the opposite: ordinary, expected, and a reason to claim again.

**One ordering bug the tests found.** Activity posts are queued, so a 409 can
surface *after* the harness has yielded and the turn has already settled as
"yielded". The abort cause is latched and checked before the turn's own ending
— otherwise the outcome depends on whether the board answered before or after
the last event arrived, and a `complete` goes out on someone else's card.

---

## Idempotency: check for prior output

**Chosen: check. Not "make the work idempotent."**

The work is a harness editing a workspace and running shell commands. Nothing
makes the second execution of that a no-op, and pretending otherwise would put
the guarantee somewhere nobody can enforce it — inside whatever the agent
decided to do.

What *can* be made idempotent is the **report**. RQ4's timeline: the harness
finished at t+180s, and at t+900s the board offered the same card again,
because the bridge died before calling `complete` and nothing on the board had
learned. Replaying the recorded handoff onto the new run is exactly recovering
the lost `complete` call. Re-running the harness is exactly wrong.

So the ordering is: work → **record the output** → tell the board → mark
reported. A bridge that dies between the second and third steps leaves a
`produced` row, and the next claim of that card finds it, reports it, and never
opens a session. The lookup is keyed on the **card**, because a reclaim mints a
new run id for the same work.

An `abandoned` run is deliberately not `produced`: replaying a half-finished
handoff onto whoever holds the card now would report work the bridge cannot
vouch for.

---

## What writes `acp_runs`, and when

`services/bridge/ledger.ts` → `startAttempt`, called when the ACP session's
first event arrives, which is when the attempt has a `start_seq`. It is the
table's **first writer**: no statement inserting into it existed at any commit
in this repository, and production holds zero rows.

It writes the paired fact the CHECK enforces — `external_run_id` = kaambaan's
`runId`, `external_source` = `"kaambaan"` — and mints `attempt_<uuid>` for its
own key. `endAttempt` closes it with an A2A state and the `end_seq` of the last
event.

**Why `bridge_dispatches` is a separate table.** An `acp_runs` row is one
prompt-turn on a station and exists for hand-driven console sessions with no
board anywhere; the shared corpus pins what its external pair means. Lease
epoch, agent identity, board, card and report state are *claim* bookkeeping —
on `acp_runs` they would be null by construction for every console session. The
new table mints no id either: its primary key is
`(external_source, external_run_id)`, the orchestrator's own identifier.

---

## Tenancy: the bridge does **not** write the tenant mapping

Every row the bridge writes carries `tenant_id`, resolved through
`resolveTenantForUser(hubUserId)` — today the bootstrap tenant
`fleet_00000000000000000000`, tomorrow whatever a membership lookup returns,
with no change here. `bridge_dispatches` is registered in
`TENANT_SCOPED_TABLES`, and the prior-output lookup is tenant-scoped: a query
keyed on a board and a card that crossed a tenant boundary would replay one
organisation's work onto another's card.

`tenants.external_id` / `external_source` is left alone, and this is a
decision rather than an omission.

**The bridge cannot learn kaambaan's tenant id.** An agent token resolves to a
tenant *inside* kaambaan and no agent-reachable response carries it: the claim
returns `{claimed, runId, leaseEpoch, card, stage, handoff}`, the run context
returns `{run, card, stage, handoff, references}`, and the only surface that
exposes `tenantId` is the board snapshot, which is a human route an agent token
cannot reach. So the only value the bridge could write is one an operator typed
into its configuration.

Promoting a config string to a database fact in a background loop is precisely
what the all-or-nothing CHECK exists to prevent — kaambaan's own migration says
it plainly: *"a wrong join is harder to notice than a missing one."* And
Decision 2 says a mapping must be **minted by an explicit link, never
inferred**. A loop that writes the mapping because a token happened to work has
inferred it.

The natural first writer is the surface where a human links the two
organisations — kaambaan already writes its half through its catalog on a
human-authenticated route. AgentPod's half belongs on the same kind of
deliberate action, not on a claim loop. Absent stays the normal, complete
state.

---

## What is still not built

- **Mid-run permission answering.** RQ2: an elicitation is a dead end in
  kaambaan — `input-required → working` exists in the state machine and nothing
  invokes it, no gate is created, and nothing constructs a `prompt` activity.
  So `ask` mode is refused at config load with that reason, and a permission
  request that does arrive (an `accept-edits` session hitting a non-edit tool)
  blocks the card for a human rather than holding the harness until the
  15-minute reclaim.
- **Cost.** RQ5 found zero token or cost fields across 1,108 events on both
  harnesses. `usage_update` is context-window occupancy and is deliberately
  *not* mapped onto kaambaan's `usage` field, which means tokens and money and
  feeds a budget cap. The peak rides in the handoff; a durable warning is
  posted once above 80%.
- **Reading the join back.** `acp_runs_external_idx` exists for the reverse
  lookup and nothing queries it. A board still cannot ask AgentPod what
  executed one of its runs.
- **Live verification.** First real run: 2026-08-14, 03:40 UTC. The happy path
  worked (claim → session → activities → `complete`, 40s) and so did recovery
  after a hand-release. The first cycle did not: it ran ~2s after a hub restart,
  before the node-agents had reconnected, claimed a card and then threw "Node is
  offline." opening the session — leaving `run_12e6594bf8de4b37` in `working`
  with `acp_run_id` empty, holding the board's only claimable card until the
  15-minute reclaim.

  Two rules came out of it, and they are now the fourth entry in `dispatch.ts`'s
  header: **nothing is claimed until the station is ready** (`stationReadiness`,
  asked before `claim`), and **a claim that never started is handed back**
  (`release`, the unpenalised verb — safe precisely because no session opened).
  A failure *after* a session opened is NOT released: the workspace may hold
  partial work, so it gets `fail`, which re-queues the card with the reason and
  a failure count that trips kaambaan's circuit breaker if it keeps happening.
  The ledger tells the two apart with `released` vs `abandoned`; `acp_run_id`
  cannot, because it is written on the first ACP event. Both results wait out
  the loop's error backoff, or claim/release becomes its own storm.
