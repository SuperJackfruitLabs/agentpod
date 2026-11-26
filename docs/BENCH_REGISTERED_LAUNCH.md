# Registered bench launch

**Status: proposed, off by default.** This note describes how the dedicated bench
coordinator launches the packaged worker through SuperBench's finite stdin
transport, and how it gets the worker's result back. It consumes contracts that
already exist in the workspace's treaty repository. It adds no contract field.

Source: [`internal/benchlaunch`](../apps/node-agent/internal/benchlaunch),
[`benchworkspace/finite_io.go`](../apps/node-agent/internal/benchworkspace/finite_io.go),
[`benchworkspace/registration_observe.go`](../apps/node-agent/internal/benchworkspace/registration_observe.go),
[`benchbridge/handler.go`](../apps/node-agent/internal/benchbridge/handler.go).

A remote stage (`fleet bench stage set --execution remote`) uses launch `remote-v1` instead: the
same prepare, lease and baseline checkpoint, then `attach` and `finish` in place of a run. See
`docs/contributor/bench-coordinator-wire.md`, "Remote launch", and
`docs/contributor/bench-checkpoint-reporting.md`, "Remote stages". A retired `remote-v1` record
checkpoints a clean tree before it releases its lease, and holds a dirty one for the operator path
below.

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
| Per-card repositories (proposed) | treaty v0.0.16 `schemas/superpipeline-api/run-checkpoint-policy.v2.json`, `run-checkpoint-selection.v1.json`, `card-repositories.v1.json`, `fixtures/superpipeline-run-checkpoint/selection.json`; agent-work.v1 `StageDef.cardCheckpointPolicy`, `CheckpointClaimDiscovery.selection`, `ClaimRequest.checkpointProtocols` | a stage whose cards choose their repositories |

## Opt-in

Two switches must both be set. Neither is set by default.

1. The Node flag `ProposedCheckpointRegistry` installs the dedicated coordinator
   (unchanged; without it nothing here is reachable).
2. A registry profile sets `"launch": "registered-v1"`. Profiles without the field
   keep the existing grouped launch byte for byte.

The Hub side of the coordinator has its own prerequisites, described in
[bench-checkpoint-reporting.md](contributor/bench-checkpoint-reporting.md):
`PROPOSED_CHECKPOINT_COORDINATOR=true` (the master switch; profiles come from
`fleet bench stage`, and an older private profile file still loads),
`ENFORCE_CONTROL_PAIR=true`, a dispatch grant (`mayDispatch`) from each
profile's owner for its agent, and a `station-plane` credential source on that
agent's roster row. Without `ENFORCE_CONTROL_PAIR=true` the Hub logs a
startup error and loads no checkpoint profile, so no registered launch is reached;
ordinary dispatch continues. A roster row that still holds a legacy token refuses
every checkpoint cycle with `authority` (`credential.missing`) before `ready` reaches
the Node, so nothing here is reached either. Give the row a source with
`fleet bridge set KEY --credential-source station-plane` (the Hub fills in the occupant, the
workspace's organization and its own SuperPipeline origin), or add the row as one with
`fleet bridge add … --credential-source station-plane` and no token; see
[DEPLOYMENT.md → Giving an agent a plane credential source](DEPLOYMENT.md#giving-an-agent-a-plane-credential-source).

## Setting up a stage

A stage is two records that must agree: the Node's private registry profile
(repositories with their clone URLs, the worker command, the launch) and the
Hub's checkpoint profile (the pins every claim is checked against). `fleet bench`
writes both, from the Hub, with no database edit, no hand-written JSON, no digest
computed by hand and no restart. A workspace owner or admin runs it.

```sh
# Before the first card: everything that can be checked, PASS or FAIL with a next step.
fleet bench doctor --station STATION

fleet bench stage add review --board brd_… --station STATION --agent agt_… \
  --repo name=app,provider=forge,repository=OWNER/app,clone=ssh://git@forge…/OWNER/app.git,base=main \
  --checkpoint-repo app --worker /usr/local/libexec/HARNESS --source-tenant tnt_…

fleet bench doctor review
fleet bench stage list
fleet bench stage set review --board brd_…   # moving the stage to another board
fleet bench stage rm review
```

`stage add` does, in order, each step idempotent and each refusal naming the step:

1. **The roster row.** The station's row for the board, created as a
   `station-plane` source row (or upgraded to one), with the owner's dispatch
   grant recorded.
2. **The Node's registry.** `bench.registry.set` sends the profile: id, selector,
   repositories with their clone URLs, the checkpoint repository, the worker
   command, the launch (`registered-v1` unless `--launch grouped`). The Node merges
   it into its private registry, validates the complete new file, renames it into
   place (a refused change writes nothing) and rebuilds its coordinator from it.
   It answers with what it now serves: `registry_sha256` (the sha256 of the bytes
   installed), each profile's exact target and each repository's digest. It never
   answers with a clone URL or an argument, and the Hub stores neither.
3. **The Hub's profile.** Built from the station (occupant, owner, occupancy
   epoch), the roster row, the workspace's organization, the Hub's own
   SuperPipeline audience, the Hub's service grant (its `sub` is the reporter) and
   the Node's reply. It is a row of `bench_stages`, and the selection snapshot is
   reinstalled at once.

A Node's digest covers every profile it serves, so a write changes the target of
each stage on that Node; the same write re-pins every other stage on it to the
Node's new target. `stage set` re-sends only what changed (moving the board sends
the selector alone; the Node keeps the repositories and worker as installed) and
re-derives the Hub's pins; `--refresh` does only that, and `--repin` re-pins the
Node's worker and coordinator digests to the installed bytes after an update. The
reply to `add` and `set` prints the stage's policy for SuperPipeline under the
stage field it goes in (`checkpointPolicy`, or `cardCheckpointPolicy` for a stage
whose cards choose; `doctor` does the same) and the steps no verb takes. In it,
`changed` is this stage's own pins that moved, and `keepBench` when the write
flipped it (each with its value before and after), and `otherStagesRepinned` names the
*other* stages on the same Node that the write moved to the Node's new digest; on
a Node that serves one stage it is empty, however much `changed` lists. `stage
rm` answers `otherStagesRepinned` too.

`--repo` is the stage's **allow-list**. A claim's policy names an ordered,
non-empty subset of it (`claimRepositoriesAllowed` in `checkpoint-profile.ts`);
`registry_sha256` pins the whole list, so a card can only select what the Node
serves. For a fixed stage the subset is the whole list and the start repository
is `--checkpoint-repo`, exactly as before.

### Cards that choose their repositories

`--cards-choose` makes the stage one whose cards choose (treaty v0.0.16, proposed).
`--default-repo N` (repeatable) is what a card that names none gets; it must hold
`--checkpoint-repo` unless it is one repository. `stage set NAME --cards-choose=false`
turns it off and drops the default; `--no-default-repo` removes the default only.

- **SuperPipeline.** The stage's policy is a `cardCheckpointPolicy`
  (`run-checkpoint-policy.v2`), which `stage add` prints. A card names
  `repositories` (and optionally `primaryRepository`) from the allow-list. At claim
  SuperPipeline narrows the allow-list to the card's choice and freezes it: the
  claim carries the **narrowed** v1 policy, its digest, and a `selection`
  (`run-checkpoint-selection.v1`) naming the stage policy's digest, the source
  (`card`, `default` or `single`), the names and the start repository.
- **Hub claim.** Only this stage's roster row sends `checkpointProtocols:
  [checkpoint-claim.v1, checkpoint-claim.v2]` beside `checkpointProtocol`; every
  other claimant's request is unchanged, and the board offers a card-choice stage
  to no other claimant. A claimant that did not ask refuses such a stage.
- **Hub check.** `readCheckpointClaim` and the context read recompute the
  narrowing from the stage's `cardCheckpointPolicy` and the claim's selection
  (`checkpoint-selection.ts`) and refuse any difference: the stage policy digest,
  the order or membership of the names, the source, the start repository, the
  narrowed policy or its digest. The profile then requires the selection (a fixed
  stage's claim must carry none) and the claim's repositories to be an ordered
  subset of the allow-list, starting in one of them. Every later check (source
  binding, prepared binding, report members, settlement) compares with the
  profile's pins for exactly the claimed repositories.
- **Node.** The prepare task carries `repository_names`, the card's choice, with
  `repository_name` its start. The Node prepares the bench with only those members
  of its registry profile, which still holds the whole allow-list and the clone
  URLs, filtered by name. The bench key is still one per card. A card whose bench
  already exists with another set or another start is refused with `unsupported`
  and a message naming what the bench holds: the choice is frozen once the bench
  exists. Reclaim the bench (`bench workspace reclaim`), then a new claim starts
  a new one. A name the registry does not serve is refused the same way.

**What stays manual**, printed by `stage add` and `doctor`:

- Accounts: the agent principal exists and occupies the station, and its grant
  has the `claim` and `run` scopes.
- Accounts: the Hub's service principal holds `checkpoints:submit` and
  `checkpoints:read` (once per deployment; add them, do not replace its scopes).
- SuperPipeline: the board agent (`agt_…`) is linked to the agent principal, and
  the stage's `checkpointPolicy` (or `cardCheckpointPolicy` for a stage whose
  cards choose) names this Node, station and agent and the stage's repositories.
- The run-only MCP token for the agent's board tools:
  `fleet bridge set KEY --mcp-token spa_…`.
- The bench host: benchd installed and running, and the coordinator registry
  installed at `proposedCheckpointRegistry` in the Node config. The registry may
  hold no stage yet; `stage add` writes the first.

**The node must have the verbs.** They answer only on a node built with them, which advertises
`bench.registry.manage` in its hello frame; an older node is refused with "this node does not
manage a bench registry from the hub; update it (fleet nodes update) and retry". `fleet nodes
update` installs the newest *release*, not `main`, so the verbs reach a node only once a release
that contains them is published. Until then, a node built from source has them; one updated from
releases does not.

The routes behind the verbs, all under the admin guard:

| Route | Verb |
| --- | --- |
| `GET /api/admin/bench/stages` | `fleet bench stage list` |
| `POST /api/admin/bench/stages` | `fleet bench stage add` |
| `PATCH /api/admin/bench/stages/:name` | `fleet bench stage set` |
| `DELETE /api/admin/bench/stages/:name` | `fleet bench stage rm` |
| `GET /api/admin/bench/doctor` | `fleet bench doctor` (`?stage=` or `?station=`) |

### When a card's bench is cleared

One card keeps one bench, handed from stage to stage and across review bounces,
so the next agent on the card finds it warm. A settlement clears nothing. Every
five minutes the Hub reads each benched card through its latest run (`GET
runs/:id`, which returns the card as it is now, on the run scope every station
already holds) and, when the card is one of these, asks each Node the card used
to reclaim the card's bench (`bench.reclaim`, Node capability `bench.reclaim`):

- **Done.** The card is `completed`. A card that arrives at a last stage nobody
  can act on is resolved `completed` by the board on arrival, so that is this case.
- **Terminal.** The card is `rejected` or `failed`. A last stage that still has
  work (a run to do, a review or checks to pass) is not terminal: the card can
  still bounce, so its bench stays.
- **Cancelled.** The card is `canceled` or archived, or the board answers `404
  RUN_NOT_FOUND` or `CARD_NOT_FOUND` for its run (a deleted card's runs go with it).
- **Dormant.** Neither the card nor any of its attempts changed for
  `BENCH_DORMANT_AFTER_HOURS` (in `hub.env`; whole hours, default 72, `0` turns
  dormancy off). A card the Hub cannot read counts its attempts' age alone.

The rules:

- **Never under work.** A card with any attempt not yet `reported`, `retired` or
  `failed` is skipped, and the board is not read. The Node derives the bench key
  from the card exactly as a prepare does, and under the bench's journal lock
  refuses (`unsettled`) while any attempt owns the bench or is not terminal; it
  reads the bench first and refuses a held lease (`lease_held`) or a bench that is
  not `ready` (`not_ready`). SuperBench refuses the same itself (`409`). Only the
  registered launch reclaims (`unsupported` otherwise).
- **Best effort.** A refusal, a timeout or an offline Node only logs (info for a
  kept bench, warn otherwise) and records nothing, so the next sweep asks again.
  A dormant card no Node would clear for 30 days is recorded `abandoned` and left
  to SuperBench's idle sweep. Each cleared attempt is recorded in
  `bench_clearances` (migration 0138) with why (`completed`, `terminal`,
  `cancelled`, `dormant`), so it is judged once; a card that comes back after that
  has a new attempt and is judged afresh, and gets a fresh bench from its card
  branch, because a prepare creates over a reclaimed key.
- **`--keep-bench`.** `fleet bench stage set NAME --keep-bench` means the Hub never
  clears that stage's benches, whatever becomes of the card; `--keep-bench=false`
  returns to the default. `fleet bench stage list` shows `keepBench`. A stage
  served only from the profile file is cleared.
- **SuperBench's own idle sweep** (`fresh_reclaim_idle_hours` in benchd's
  `activation.json`) reclaims a released bench by the time since its last lease
  release, knowing nothing of cards. It is the backstop for a Hub that is down or
  a card it can no longer read. Set it above `BENCH_DORMANT_AFTER_HOURS`: a grace
  shorter than a review clears the warm bench before the card comes back.
- **Capacity.** Benches now live as long as their cards, one per card active
  within the dormancy limit. Size the host's quota for that, or lower the limit.
- **Host step:** `reclaim` is a SuperBench operator operation, so the Node's user
  must be in benchd's `--operator-uids`. Otherwise every reclaim is refused
  (`forbidden`) and only logged.

### An install from before the verbs

Nothing changes on upgrade. Migration 0135 creates an empty `bench_stages`, and an
empty table shadows nothing: the private profile file and its two `hub.env` lines
keep loading as before, once per configured path. A table row replaces a file
profile for the same station and board, or the same stage name in the same
workspace. The first time the Hub rewrites a Node's registry (any `stage add`,
`set` or `rm` on that Node), each file profile on that Node is adopted into the
table, re-pinned to the Node's new digest, so the file's stale pin is never
served. `fleet bench stage list` shows them as `file`, and a profile still only in
the file as `file-only`; `stage set NAME` takes one over. Once every stage is a
row, the file and `PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE` can go.

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
| Producer `in_progress` / `operation_in_doubt` / `unavailable`, live | parsed error code on the live reply | same as a lost reply | `pending` |
| Run killed by a SuperBench restart | the run's completed receipt replays a stored `503 unavailable` whose result shows this holder's lease stopped with `stop_requested` (benchd logs `command failed; stopped lease retained: signal: killed`) | a completed receipt is final whatever its code (treaty "A completed stored failure is final"): terminal, never a pass, nothing resent, no `stop` (the execution is already stopped); the stopped lease is released with this record's token. A stored `operation_in_doubt` still parks | `refused` `verification_failed` |
| Cancellation before launch | `Cancel` before step 8 | veto journaled first; held lease released with its token; no run is ever sent | `refused` `stale_owner` |
| Cancellation mid-run | `Cancel` after step 8 | veto journaled; one cancel request targets the run's request ID and digest; `cancel_requested` is recorded as intent only. Later lookups observe the final receipt; its result is never published; the lease is released | `pending`, then `refused` `stale_owner` |
| Run cancelled before its reply was stored | the run's receipt lookup answers `cancel_requested`: the cancellation barrier won, SuperBench refused to store the reply (benchd logs `receipt_save_failed`, "operation cancellation requested") and the lookup never upgrades it, so no completed receipt can ever come | a status read must show this holder's lease `stop_requested` with its execution `stopped` (or the lease no longer ours); until then it stays parked. Then the record ends refused, never completed, and the stopped lease is released with the record's own token. No `stop` is sent and nothing is checkpointed to make the release succeed (treaty: "Cancellation does not release") | `pending`, then `refused` `stale_owner` for a record the hub vetoed, `verification_failed` for a run cancelled by anyone else |
| Context cancelled while waiting for the run reply | transport error | same as a lost reply; no resend | `pending` |
| Stale holder | hub `current` check before every send and after every await; journal `active` pointer; producer `conflict`/`forbidden`; lease grant for another holder | no further send; lease not released by a non-owner. A definitely superseded record retires itself (see below) | `refused` `stale_owner` (a newer attempt gets `pending` until the older record is terminal) |
| Capacity refusal | `capacity_exhausted` (HTTP 422) on create, lease or run | terminal for the attempt; never retried; a held lease is released | `refused` `capacity_exhausted` |
| Worker crash | run response with a nonzero exit code, or no valid frame on stdout | terminal; lease released when still held | `refused` `verification_failed`; when the nonzero run's stdout holds a failed result for this binding, its `handoff.error` travels as `detail.task` |
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
on the next cleanup; nothing replays a bad answer. Retries never stop, and every
failed release is logged with the bench key, the count and SuperBench's message.
After three, `Status` reports `release_refused` instead of `cancel_requested`.

### A refused release

SuperBench refuses a release without a complete clean checkpoint vector: a
dirty or untracked tree, a rejected push, an ambiguous state save. The refusal
does not clear itself, and the node never checkpoints interrupted work to make
the release succeed (treaty, "A completed stored failure is final"). Once the
hub has ended the attempt only the card's next attempt retries the release, so
staging saw four retries, then silence, and a lease still held.

From the first refused release the record reports it: its refusal and every
parked status carry `detail.lease: "held"` and SuperBench's message, and the
hub says on the card (`checkpoint.parked`, code `lease_held`), once per
attempt, what an operator must do. When the board already ended the run the
hub only logs it, since an activity would heartbeat the unbound run. The card's
next attempt waits on the held bench (`pending`, never a new lease or run) and
its reply carries the same `detail.lease: "held"`, so its card says it too.

The supported path, run as the bench host's operator (SuperBench's "Leases"
concept and `bench workspace` reference):

1. `bench workspace stop_admin <key>`. It fences the recorded scope; the lease
   stays held by the attempt's holder (`cp_<attempt>`, shown by
   `bench workspace status <key>`). A stopped token never launches again.
2. A root `bench workspace renew_admin --state <dir> --data <dir> <key>`, with
   benchd's own state and data roots (it is a local verb, not a socket call, and
   defaults to the CLI's roots). It retires the stopped token and prints its
   successor for the same holder (`grant_token`), with a fresh continuation.
   Keep it out of logs.
3. A root `bench workspace run --holder <holder> --request-id <fresh id> <key> --
   <command>` with the renewed token in `BENCH_LEASE_TOKEN`, no
   `--repository-name`, whose command commits or removes the stray files. With
   the default `--checkpoint`, a successful run checkpoints the member vector and
   releases.
4. `bench workspace status <key>`; only if the lease is still shown, `bench
   workspace checkpoint` and `bench workspace release` with the same token.
   Releasing twice can fail once the first cleared the lease.
5. Optionally `bench workspace reclaim <key>` to delete the released tree (the
   Hub does this itself once the card is done, cancelled or dormant, unless its
   stage is `--keep-bench`).
   The next attempt on the card creates the bench again.

The node's next release for that record then finds the lease gone and ends the
record clean.

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
new refusal code, `capacity_exhausted`, and an optional `detail` on `refused` and
`pending` replies: `detail.message` is SuperBench's own text for the refusal that
ended the record (journaled as `producer_message`, or `release_refusal` for a
refused release), at most 256 UTF-8 bytes with control characters removed. It
says why; it never changes what the state or code means. The hub never re-sends `prepare` or
`execute` after a refusal: later cycles send `status`, which returns the same
terminal refusal from the journal. A terminal refusal ends the hub's attempt:
`verification_failed` and `unsupported` fail the run, `capacity_exhausted`
releases the card for a new claim (contributor/bench-checkpoint-reporting.md,
"When the node refuses"). The reply a node sends after a worker crash is pinned
in `packages/contract/src/fixtures/bench-coordinator-node-refusals-v1.json`.

## Known gaps

- SuperBench's daemon does not yet accept the finite IO profile on
  `/v2/operations` or on `/v2/receipts/lookup`, and its run result has no `io`
  field yet (its codec, `payloadlaunch.PreparePayloadInput` and the treaty
  vectors exist). Until it does, the daemon answers step 8 with
  `invalid_request`, which surfaces as `refused` `unsupported`; nothing ran.
- The coordinator wire has no `cancel` operation. `Coordinator.Cancel` is a Node
  API, covered by tests; a hub caller (the board's cancel reaching the node) is a
  follow-up. Until then a newer attempt's `prepare`, or `status` after a
  `stale_owner` decision, is what retires an abandoned record. When the board
  ends an attempt's run (the card moved, cancelled, deleted or reclaimed), the
  hub's current decision answers `stale_owner` and the hub sends that `status`
  itself (contributor/bench-checkpoint-reporting.md, "When the board ends the
  run").
- None of this proves a provider-backed task. The installed payload home,
  provider configuration and a real fenced run still need live proof.
