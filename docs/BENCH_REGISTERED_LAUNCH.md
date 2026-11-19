# Registered bench launch

**Status: proposed, off by default.** This note describes how the dedicated bench
coordinator launches the packaged worker through SuperBench's finite stdin
transport, and how it gets the worker's result back. It consumes contracts that
already exist in the workspace's treaty repository. It adds no contract field.

Source: [`internal/benchlaunch`](../apps/node-agent/internal/benchlaunch),
[`benchworkspace/finite_io.go`](../apps/node-agent/internal/benchworkspace/finite_io.go),
[`benchworkspace/registration_observe.go`](../apps/node-agent/internal/benchworkspace/registration_observe.go),
[`benchbridge/handler.go`](../apps/node-agent/internal/benchbridge/handler.go).

## Why

The older grouped launch writes the worker's task into a Node-private context
directory and passes that path to `run`. Under a separate payload identity the
worker cannot read that directory, and making it readable is not acceptable.
The registered launch sends the task as bytes instead. SuperBench copies them
into a sealed memfd and binds it to the payload's stdin once. The worker writes
one framed result to stdout. SuperBench returns the exact stdout only after it
has fenced the execution, drained the output and sealed the capture.

## Contracts consumed

| Contract | Where | Used for |
| --- | --- | --- |
| Finite IO profile `superbench.finite-io.v1` | treaty `docs/2026-11-16-superbench-private-execution-io.md`, `fixtures/superbench-api/private-execution-io.json`, `schemas/superbench/finite-io-*.json` | stdin delivery, stdout result, profiled receipt lookup |
| Registration observation | same treaty document, `schemas/superbench/registration-observe-*.json` | the physical layout the capsule binds |
| Registered worker capsule and result | treaty `docs/2026-11-16-registered-worker-capsule.md`, `schemas/agentpod-local/registered-worker-*.json` | the stdin frame and the stdout frame |
| Receipt lookup and cancellation | treaty `fixtures/superbench-api/receipt-lookup*.json`, `cancellation*.json` | lost replies and cancellation |
| Capacity refusal | treaty capacity extension (AgentPod #901) | `capacity_exhausted`, HTTP 422 |

## Opt-in

Two switches must both be set. Neither is set by default.

1. The Node flag `ProposedCheckpointRegistry` installs the dedicated coordinator
   (unchanged; without it nothing here is reachable).
2. A registry profile sets `"launch": "registered-v1"`. Profiles without the field
   keep the existing grouped launch byte for byte.

The Hub side of the coordinator has its own prerequisites, described in
[bench-checkpoint-reporting.md](contributor/bench-checkpoint-reporting.md):
`PROPOSED_CHECKPOINT_COORDINATOR=true` with a private profile file,
`ENFORCE_CONTROL_PAIR=true`, a dispatch grant (`mayDispatch`) from each
profile's owner for its agent, and a `station-plane` credential source on that
agent's roster row. Without `ENFORCE_CONTROL_PAIR=true` the Hub logs a
startup error and loads no checkpoint profile, so no registered launch is reached;
ordinary dispatch continues. A roster row that still holds a legacy token refuses
every checkpoint cycle with `authority` (`credential.missing`) before `ready` reaches
the Node, so nothing here is reached either. Give the row a source with
`fleet bridge set KEY --credential-source station-plane …`, whose audience is the
Hub's own SuperPipeline origin; see
[DEPLOYMENT.md → Giving an agent a plane credential source](DEPLOYMENT.md#giving-an-agent-a-plane-credential-source).

## Sequence

The hub's two coordinator calls stay as they are: `prepare`, then (after the hub
admits the source binding) `execute`. `status` reads progress at any time.

```
prepare
  1. reserve      journal the immutable SourceSpec + task digest (no I/O)
  2. create       growth op, request_id = create_<attempt>      (only when the bench is new)
  3. lease        growth op, request_id = lease_<attempt>       -> grant for our holder
  4. checkpoint   lease-token op                                -> checkpoint vector
  5. observe      POST /v2/registrations/observe (key, bench_id, holder, lease_token)
  6. capsule      build RegisteredCapsule(task, layout) -> body, sha256(body)
  7. bind         run request = {key, holder, request_id = run_<attempt>, lease_token,
                    arguments = [worker, "registered-v1", sha256(body)],
                    io = {stdin_base64 = BE32 frame, stdout_limit_bytes = 65540}}
                  journal the exact request bytes; return the SourceBinding
execute (after the hub admitted binding_sha256)
  8. launch       journal "sent" BEFORE transport, then POST once with the profile
  9. result       parse the run response; decode io.stdout; ParseRegisteredResult
 10. readback     profiled receipt lookup for (run_<attempt>, typed digest);
                  the completed body must equal the captured response byte for byte
 11. release      release with the lease token if the response left the lease held
 12. completed    Completion{source binding, service observation, worker result}
```

The source binding keeps its existing shape. `context_sha256` is the capsule body
digest, `request_sha256` and `body_sha256` are the profiled run request's raw and
typed digests, and the operations are the observed `create`, `lease` and
`checkpoint` steps. The service observation kind stays `grouped-v2`: the worker
result is the grouped v2 result; only its transport changed.

## Idempotency keys

| Step | Key | Replay rule |
| --- | --- | --- |
| create, lease, run | `request_id` plus the typed body digest (producer receipts) | never resent after "sent" is journaled; recovered by receipt lookup only |
| stop (stuck bench, see below) | the initialization owner's lease token | sent at most once per attempt; a lost reply is settled only by a `status` read showing the owner stopped, never by a resend |
| checkpoint, release | lease token | resent only when the journal holds no response; a lost release reply is reconciled from `status` |
| observe | key, bench_id, holder, lease_token | read-only; repeatable while the lease is ours |
| receipt lookup, cancel | `target_request_id` + `target_digest` | read-only / idempotent producer extension |

The request IDs are derived from the attempt identity (`intentName`), so a hub
retry of the same attempt reaches the same journal record, never a new launch.

## Failure and retry paths

| Failure | Detected by | What happens | Hub sees |
| --- | --- | --- | --- |
| Lost reply on create/lease/run | transport error, no complete body | step stays "sent"; nothing is resent. `status` performs a profiled receipt lookup with the same request ID and digest. `completed` replays the original bytes into step 9; `absent`, `in_progress`, `operation_in_doubt` stay parked | `pending` until the lookup returns `completed` |
| Producer `in_progress` / `operation_in_doubt` / `unavailable` | parsed error code | same as a lost reply | `pending` |
| Cancellation before launch | `Cancel` before step 8 | veto journaled first; held lease released with its token; no run is ever sent | `refused` `stale_owner` |
| Cancellation mid-run | `Cancel` after step 8 | veto journaled; one cancel request targets the run's request ID and digest; `cancel_requested` is recorded as intent only. Later lookups observe the final receipt; its result is never published; the lease is released | `pending`, then `refused` `stale_owner` |
| Context cancelled while waiting for the run reply | transport error | same as a lost reply; no resend | `pending` |
| Stale holder | hub `current` check before every send and after every await; journal `active` pointer; producer `conflict`/`forbidden`; lease grant for another holder | no further send; lease not released by a non-owner. A definitely superseded record retires itself (see below) | `refused` `stale_owner` (a newer attempt gets `pending` until the older record is terminal) |
| Capacity refusal | `capacity_exhausted` (HTTP 422) on create, lease or run | terminal for the attempt; never retried; a held lease is released | `refused` `capacity_exhausted` |
| Worker crash | run response with a nonzero exit code, or no valid frame on stdout | terminal; lease released when still held | `refused` `verification_failed` |
| Invalid result | stdout fails the io digest, the frame, the canonical bytes or the binding | terminal; lease released when still held | `refused` `verification_failed` |
| Producer without the finite profile | `invalid_request` or `not_found` on the run | terminal; nothing ran; lease released | `refused` `unsupported` |
| Readback mismatch | receipt body differs from the captured response, or `absent` after a captured reply | terminal; nothing published | `refused` `verification_failed` |
| Lost readback or release reply | transport error | retried on the next `status`; read-only or token-scoped | `pending` |

No path makes a Node-private file readable by the payload UID. The only bytes the
payload receives are the capsule frame on stdin.

## Stale attempts clean up after themselves

A record that the hub has moved on from must not hold the bench forever. The
node may clean up **its own** journal record without a current decision, under
the per-bench lock: it never sends or resends a run, releases the lease the
record holds with that record's token (a lease already gone counts as
released), and marks the record terminal (`Cancelled`, `stale_owner`).

| Entry point | Trigger | Authorised by |
| --- | --- | --- |
| `Status` | the hub answers `current` with an authenticated, fresh `refused`/`stale_owner` decision (`ErrSuperseded`) | that decision. A hub that cannot be reached or answers anything else retires nothing |
| `Cancel` | always | the journal record's identity: the exact reserved spec (tenant, board, card, run, epoch, attempt). No current decision is needed |
| `Prepare` of a newer attempt on the same card | its own decision is current while an older record still owns the bench | the newer attempt's current decision. The older record is retired first; the newer one reserves once it is terminal, otherwise `pending` |
| `Execute` | stale decision | refuses with `stale_owner` and sends nothing; it does not retire |

A `status` for an attempt whose target the node no longer serves (a node build
or pin change replaced its profile) can never prepare or execute again. The
node retires its own record and answers `refused` `stale_owner` only when two
keys agree: the hub's authenticated current decision for the attempt's own
retained identity, target and profile is `stale_owner`, and the record provably
launched nothing. That is an intent that never handed off its effects (no source
call was made), or a registered journal record whose run was never sent: the
veto is journaled first and the record's lease released with its own token. A
sent run, a grouped launch, or no intent at all stays `refused` `unavailable`
for an owner or admin. The hub's superseded-attempt path then retires the
attempt with this reply as its evidence.

The veto covers any record that still holds its lease, including one already
refused (for example `capacity_exhausted` whose first release failed) or
completed. It authorises release and cancel only, never a run.

After launch, retiring sends one cancel for the run's exact target and waits for
the run's receipt. A newer attempt's `prepare` frees the bench only once the
older record is terminal; until then (lease still held, or run unresolved) it
returns `pending`, retryable, and reaches nothing. A definite refusal of a
release we still hold, or a reply that does not parse, is forgotten and sent again
on the next cleanup; nothing replays a bad answer. Retries never stop, but after
three failed releases each further failure is logged with the bench key and
count, and `Status` reports `release_refused` instead of `cancel_requested`.

### Reclaimed benches and generations

SuperBench may reclaim an idle, released bench, and a later create on the same
key makes the key's next generation with a new `bench_id` that no earlier
generation had. Before the lease request leaves, the record keeps the
generation it is sent to: the created bench's `bench_id`, or the one a status
read shows. When a grant is observed, the record keeps the grant's `bench_id`.

- An unresolved lease is recorded as gone only when a status read shows **that**
  generation `reclaiming` or `reclaimed`. A different generation in any phase
  proves nothing: the old request may still land there. The record stays
  parked, and if the late grant shows up in the lease's receipt it is released
  with that grant's own token.
- A grant on a generation other than the one the lease was sent to (the bench
  was reclaimed and created again while the request was in flight) is refused
  with `stale_owner` and released.
- After a refused release, the lease is gone when a status read shows the
  grant's own generation no longer leased to us, or a later generation: one is
  created only once the grant's generation is reclaimed, and only a released
  bench is reclaimed. An unknown generation is not proof.
- A record from before generations were kept has none, and a reclaim never
  counts as proof for it: it stays parked for an operator rather than risk an
  unreleased grant on a new generation.

Known limit: a lease request carries no `bench_id`, so SuperBench cannot refuse
a request that was still in flight after its own generation was reclaimed. If
the old generation is seen reclaimed, the record ends, and the key is created
again before that request arrives, the late grant lands on the new generation
with no record left to release it. The gap is bounded: SuperBench reclaims a
bench only after it has been released and idle for the reclaim grace
(`fresh_reclaim_idle_hours`, 24 hours by default), and the node's request
timeout ends a lease request long before that. A request would have to outlive
the grace. The follow-up fix is a lease request that carries the `bench_id` it
expects, so SuperBench refuses it on any other generation.

### Benches stuck before ready

A create that never finished leaves the key's workspace `materializing` or
`initializing`, held by its `initialization` owner, and every lease on it is
refused. SuperBench lets a `create` with a new request ID make the key's next
generation once that owner is stopped and the host frees the old tree; until
then the create is refused with `409 conflict`. The registered launch uses
this; the grouped launch is unchanged and still leases.

- The bridge's status read sees the stuck phase and chooses a create with this
  attempt's own request ID (`create_<attempt>`), as it does for a reclaimed key.
- Before the create, the record keeps the stuck generation's `bench_id`. If a
  status read shows its owner not yet stopped, the node looks in the key's
  journal for the owner's token: the initialization grant that an earlier
  attempt's failed create returned (or, when that reply was lost, its
  receipt), on that same generation. With it, the node sends one `stop`. A
  token from another generation, or none, means the owner is not ours: the
  attempt parks as `bench_stuck` and sends nothing. The node never sends
  `stop_admin`; an operator's stop frees the key for the next attempt.
- A refused stop parks as `bench_stuck`. A lost stop reply parks until a
  status read shows the owner stopped; it is not resent.
- The create's `409 conflict` parks as `recreate_refused`. The journaled
  refusal is replayed on every retry; nothing is resent and nothing stops
  again. The hub's next attempt retires the parked record and tries once more
  with its own request ID.
- A successful create must name a `bench_id` other than the stuck one; it is
  then a fresh bench whose generation is pinned and bound like any created
  one. Otherwise the attempt is refused with `verification_failed`.

`Status` reports `bench_stuck` and `recreate_refused` in place of a plain
`pending` (the wire still says `pending`), and each park is logged once with
the bench key.

On the hub, `stale_owner` is reserved for a definite change (the attempt row is
gone, or its run, epoch, attempt or owner authority changed). A row that merely
moved between the hub's two reads answers `unavailable`, which retires nothing.

### Known limit: the grouped path

The grouped (non-registered) launch still has the stale-after-prepare lockup:
after a successful prepare, a stale decision leaves its lease held and its
journal record active, because its `Status` and `Cancel` require a current
decision. A newer attempt on that card then waits on the bench. Applying this
record-identity cleanup to `benchcoordinator.Manager` and the `benchdispatch`
cancellation store is a follow-up.

## What the hub sees

A `status` for an attempt whose prepare the node never resolved (its intent is
reserved with no chosen spec, because the in-prepare current check or the
read-only bench choice failed) answers `unknown`. Nothing was chosen and no
source effect was invoked. The hub answers it by re-sending the identical
retained prepare; any other prepare bytes for the attempt are refused.

A `pending` status in prepare is re-sent the same way. The identical prepare
resumes the registered launch from its journal: a reservation whose own current
check failed before any SuperBench call continues with create, lease and
checkpoint, and every step that was already sent is recovered by receipt
lookup, never resent. A current check that fails during `status` (a slow or
unreachable hub) leaves the record parked (`pending`); only an authenticated
`stale_owner` decision makes it retire and answer `stale_owner`.

The coordinator wire (`agentpod.bench-coordinator.v1`) is unchanged except for one
new refusal code, `capacity_exhausted`. The hub orchestrator reports it as an
unreported attempt whose reason names exhausted capacity, and never re-sends
`prepare` or `execute`: every later cycle sends `status`, which returns the same
terminal refusal from the journal.

## Known gaps

- SuperBench's daemon does not yet accept the finite IO profile on
  `/v2/operations` or on `/v2/receipts/lookup`, and its run result has no `io`
  field yet (its codec, `payloadlaunch.PreparePayloadInput` and the treaty
  vectors exist). Until it does, the daemon answers step 8 with
  `invalid_request`, which surfaces as `refused` `unsupported`; nothing ran.
- The coordinator wire has no `cancel` operation. `Coordinator.Cancel` is a Node
  API, covered by tests; a hub caller (the board's cancel reaching the node) is a
  follow-up. Until then a newer attempt's `prepare`, or `status` after a
  `stale_owner` decision, is what retires an abandoned record.
- None of this proves a provider-backed task. The installed payload home,
  provider configuration and a real fenced run still need live proof.
