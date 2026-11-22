# Dedicated checkpoint reporting (default off)

The coordinator design is accepted with conditions before enablement. Acceptance
establishes the suite-to-SuperBench ownership boundary; it does not provision a
grant, accept every optional wire extension or enable a pilot. This code installs
no configuration, service credential or stage policy. The standalone host-local
SuperBench lifecycle remains independent of the suite coordinator.

The internal Hub source client uses the existing organization issuer's service
token endpoint and verifies its EdDSA signature, audience, organization, service
principal, expiry, entitlement and operation scope. The service credential stays
in the Hub. Source HTTP calls have fixed server-selected origins, no redirects,
bounded bodies and static errors. A lost admission response is uncertain; it is
never a reason to run the child again. Settlement transport remains default off
and uses only the exact retained submission.

Hub `fleet_*` and SuperPipeline `tnt_*` identifiers belong to separate local ID
spaces. A server-owned profile pins both to the issuer organization; neither a
worker nor a claim can define that mapping. The same profile maps each logical
member's repository hash to the policy's provider/repository allowlist. An
arbitrary hash does not authorize a repository, and private clone URLs are not
public checkpoint evidence. The profile separately pins the actual coordinator
implementation digest, managed execution mode, registry revision and packaged
worker digest. `superbench.v2` names the bench protocol only.

The source projection is checked against the exact pending claim and policy.
A historical source GET can return an ended run. That read does not renew a
lease: new publication requires the same stored source, working run and fresh
heartbeat. The source admission receipt digest identifies the admitted source;
it is distinct from the canonical execution receipt digest in a settlement.

Canonical conformance uses the shared fixture
`fixtures/superpipeline-run-checkpoint/canonical.json`, SHA-256
`e199f937c17a28edf8b0ab7285870faf0880dba23ccf15f51604e183052e7fb0`.
Tests import plain fixtures, never another product's TypeScript. Matching a
schema, canonical digest or fixture does not prove an issuer grant, remote
fencing or a successful lifecycle. Optional protocol extensions still require
their own acceptance and producer/consumer conformance before enablement.

The default-off Hub callback and immutable attempt table now retain the original
prepare request/selected authorization before Node effects. The callback verifies
the actual enrolled Node credential and compares fresh database occupancy, issuer
control-pair and SuperPipeline pending/current-source observations after awaits.
Private physical profile configuration is read only under the literal proposed
flag; no configuration is supplied or enabled by these source changes.

`PROPOSED_CHECKPOINT_COORDINATOR` must equal the literal `true` before the
Hub reads any dedicated profile. Unset or other values keep this path disabled.

Two prerequisites must hold before the coordinator can select any work:

- **`ENFORCE_CONTROL_PAIR=true`.** Checkpoint authority is defined only under
  control-pair enforcement. With the coordinator on and enforcement off, the Hub
  logs a startup error naming `ENFORCE_CONTROL_PAIR` and loads no checkpoint
  profile, so checkpoint dispatch stays off. Ordinary dispatch is unaffected.
- **A dispatch grant for each checkpoint agent.** The profile's owner principal
  must carry the occupant agent's principal ID in its issuer `mayDispatch`
  claim. Without it every selection refuses with `authority`.
- **A plane credential source on the checkpoint agent's roster row.** The
  checkpoint client spends no stored token. It exchanges the occupant's own plane
  identity for a short-lived, verified grant on each request, so the row named by
  the profile's `agentKey` must carry a `station-plane` credential source. A
  legacy token row (`credential_source` NULL) refuses every cycle with `authority`
  and reason `credential.missing`, before the Node is asked anything. The source
  names the occupant principal, the workspace organization and this deployment's
  SuperPipeline audience: the origin of the Hub's `SUPERPIPELINE_BASE_URL`, and
  nothing else. It must also equal the profile's `sourceAudience`. The agent's
  grant at the organization plane must carry SuperPipeline's agent scopes,
  `claim` and `run`: the exchanged grant takes its scopes from it, and one
  without `claim` is refused on every request (`credential.claims.scope`).
  Setting the source checks for both up front and names any that is missing. See
  [DEPLOYMENT.md → Giving an agent a plane credential source](../DEPLOYMENT.md#giving-an-agent-a-plane-credential-source)
  for the command on staging and on production.

A refusal is scoped to checkpoint work. A refused selection or checkpoint client
never ends the agent's claim cycle: the cycle continues with an ordinary claim,
which the board never answers with a checkpoint stage. Each distinct refusal code
and reason is logged once per agent as `checkpoint dispatch refused; ordinary claims continue`,
then at most once every 15 minutes with the count suppressed meanwhile. Refusals
still refuse; this changes only how far they reach and how often they are logged.

An `authority` refusal also logs a `reason`, a fixed word that names the first
pin that failed. The reason is for the Hub's log only: on the wire the refusal is
still `authority`, and the reason never contains an identifier, token or raw error.

| Reason | What failed |
| --- | --- |
| `facts.row` | No enabled roster row joins the pinned station, tenant, node and board |
| `facts.enforcement` | `ENFORCE_CONTROL_PAIR` is not `true` |
| `facts.tenant.source`, `facts.tenant.organization` | The tenant is not the pinned issuer organization |
| `facts.node`, `facts.principal`, `facts.owner`, `facts.epoch`, `facts.profile` | The station's node, occupant, owner, occupancy epoch or roster profile differs from the pin |
| `node.status`, `node.offline`, `node.last_seen` | The node row is not online, the Hub has no live session for it, or its last heartbeat is older than 45 seconds |
| `issuer.occupant.*`, `issuer.owner.*` | The issuer does not return the principal, or it is suspended, in another organization, or the occupant is not an agent |
| `issuer.grant` | The owner's `mayDispatch` does not cover the occupant |
| `credential.missing` | The roster row has no plane credential source (a legacy token row), or the stored source does not parse |
| `credential.principal`, `credential.organization` | The source differs from the profile's occupant or organization |
| `credential.claims.scope`, `credential.claims.ent`, `credential.binding.changed`, … | The exchanged plane grant was refused before any request: no `claim` scope, no `superpipeline` entitlement, a binding that changed. Nothing was claimed, so the cycle goes on to ordinary claims |
| `credential.audience` | The source's audience is not this Hub's configured SuperPipeline audience (the origin of `SUPERPIPELINE_BASE_URL`; unset admits none), or differs from the profile's `sourceAudience` |
| `selection.identity`, `selection.target` | The cycle asked about another station, or about a target that is not the profile's |
| `node.state:<state>.<code>` | The node's ready reply was not `available`, for example `node.state:refused.unavailable` |
| `node.target.<field>` | The node advertised a target that differs from the profile's in that field |
| `claim.*` | A claimed checkpoint policy breaks one of the profile's pins |
| `current.<code>`, `current.error` | Re-reading current authority failed for a reason other than one of the above |
Profiles come from two places. A stage written with `fleet bench stage` is a row
of `bench_stages`, built from the node's own registry reply, and is installed
into the selection snapshot at startup and after every stage write, with no
restart (BENCH_REGISTERED_LAUNCH.md, "Setting up a stage"). The older private
file still loads, and a table row replaces a file profile for the same station
and board or the same stage name. Without `ENFORCE_CONTROL_PAIR=true` neither is
served.

`PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE` selects an absolute physical
JSON file, at most 64 KiB, in a private directory. The file and directory must be
owned by the service user or root and inaccessible to other users; symlinks are
refused. The versioned profile pins the issuer organization, both tenant ID
spaces, selected workspace and agent, repository mapping and installed Node,
worker and registry digests. `profileKey` selects the exact bridge harness profile,
including `""` for its default profile. Optional `coordinatorProfileId` selects the
Node registry profile independently and must be nonempty. Named harness profiles
retain their existing coordinator ID when this field is omitted; a default harness
profile requires it explicitly. Null and empty profile keys are not interchangeable
in stored roster ownership checks. Missing or invalid configuration refuses dedicated
work. A failed load is logged once with a closed code and disables only dedicated
selection; unrelated agents continue through their ordinary bridge path. Generic
clients still reject actual checkpoint claims and every non-null policy, so a
broken installation cannot silently execute policy-required work through ACP.

File profiles are an immutable process snapshot, loaded lazily once per configured
path, including a failed load. Editing, repairing, replacing or deleting the same
file does not reload that snapshot: restart the Hub to apply it, or take the stage
over with `fleet bench stage set NAME`, which needs no restart. A changed server
configuration path selects a new snapshot; no file watcher or periodic read runs.
Roster loop construction selects its dedicated runtime once. Every operation still
rechecks the literal flag, current issuer/control pair, selected station/node,
run/epoch and policy around awaits; snapshot caching does not cache authority.
These settings provision no credentials, policy or capability; no profile or
environment setting is installed by this change.

The bench task the Hub reserves names the profile's checkpoint repository as
`repository_name`, so the node's worker starts the harness inside that member.
Without it the harness started in the bench's workspace root, wrote files outside
every repository and left the tree dirty, and SuperBench then refused checkpoint
and release. A profile whose checkpoint repository is missing or is not one of
its repositories is refused at load, so a single-repository profile names its
only repository.

Starting inside the member means a harness's own scratch can land in the
checkout: a soak saw Hermes write `.hermes/cache/scratch/run_tests.py` there
by a relative path, though its `HERMES_HOME` is outside the bench, and every
such run was refused as dirty. Before it starts the harness, the registered
worker adds each harness's scratch patterns (`/.hermes/cache/` for Hermes;
`harnessScratch` in `registered_worker.go`) to every member's own
`info/exclude`. Each member has its own independent Git directory in the bench,
so the exclude is never committed, never shared with another bench, and the
repository's tracked `.gitignore` is not touched. SuperBench's dirty check
(`git status --porcelain --untracked-files=all`) honours it. A harness's
project files beside the cache (`.hermes/skills`, `.hermes/plugins`) are task
content and stay visible.

## What the card shows

Each phase the Hub commits posts one short activity to the card's live stream,
through the same run verb ordinary dispatch uses: `checkpoint.prepared`,
`checkpoint.running`, `checkpoint.completed`, `checkpoint.pushed` (each member's
branch and commit), `checkpoint.submitting`, and `checkpoint.parked` (the phase,
closed code and reason). Only the pass whose compare-and-set committed a phase
posts it, and a park is posted once per attempt, phase and reason, not on every
re-check. An activity is posted after the commit and its failure is only
logged (`checkpoint activity: activity.post`): the ledger, the node and the
settlement never wait on it or read it back.

## When the node refuses

The node's registered launch answers a closed set of refusal codes
(BENCH_REGISTERED_LAUNCH.md, "Failure and retry paths"). Some come only from a
journal record the node holds as terminal, after it released what the record
held: that attempt can never complete, and parking it kept the card `working`
on heartbeats forever. Others are said about the moment and can still turn into
a completion. The Hub rules each code by the phase that asked
(`checkpoint-refusal.ts`, `CHECKPOINT_REFUSAL_RULINGS`); a code or phase the
table does not name parks.

| Code | `prepare_pending` | `execute_pending` | Why |
| --- | --- | --- | --- |
| `verification_failed` | failed | failed | A worker crash, a run killed before it finished (a SuperBench restart stores its reply as a final failure receipt), a result or receipt that did not verify, or a producer reply that did not parse. Journaled terminal, lease released |
| `unsupported` | failed | failed | The producer refused the request (`invalid_request`, `not_found`): nothing ran, and the same request would be refused again |
| `capacity_exhausted` | released | released | SuperBench refused create, lease or run for capacity: terminal, nothing ran |
| `conflict` | released | parked | Before execute, another holder owns the bench and nothing of this attempt ran. After it, only a journal step that does not match its own bytes, which proves nothing about the run |
| `stale_owner` | parked | parked | Also what the node answers when its own current check cannot reach the Hub. A superseded attempt is retired with evidence (below), never here |
| `unavailable` | parked | parked | The node's catch-all for an internal error, a registry it cannot load or a refused current check |
| `invalid`, `unauthorized`, `pending` | parked | parked | In the contract but never sent by the node's coordinator; not guessed at |

- **Failed** settles the run on SuperPipeline as failed through the ordinary run
  verb, `POST /v1/boards/:board/runs/:run/fail` with the lease epoch and a
  one-sentence reason that names the code. The board ends the run `crashed`
  with that `failure_reason`, posts `card.failed` and applies its own retry
  policy. A checkpoint stage refuses `complete`, never `fail`.
- **Released** hands the card back without penalty, `POST …/runs/:run/release`:
  the card is claimable again. After a `capacity_exhausted` release the station
  waits before its next checkpoint claim (below, "After a capacity refusal").
- **Parked** stays on its phase, logged and shown on the card with reason
  `node.state:refused.<code>`, and is read again on the next backoff. A reply
  that is not a refusal and not the phase's success parks naming its state:
  `node.state:pending`, `node.state:unknown`, `node.state:superseded`. No park
  names nothing: one that throws without a reason parks as `drive.error`, with
  the error's class in the log.

Neither ruling ever reports a pass: no settlement is built and `complete` is
never sent.

**The bench's own words.** When SuperBench refused the step that ended the
record, the node's refusal carries its message as `detail.message` (at most 256
UTF-8 bytes, no control characters). The Hub redacts it (`redact`, and absolute
paths become `[path]`), bounds it to 200 characters and puts it in the sentence,
which is both the `checkpoint.failed` activity and the run's `failure_reason`.
For example: `Checkpoint failed: SuperBench refused the bench step after the run
(verification_failed): "bench has uncommitted or untracked files; commit or
preserve them before checkpoint/release". Nothing was reported as a pass.`
Without a message the sentence is the table's.

**The task's own reason.** For a failed run SuperBench's message only says
`operation failed; inspect retained workspace state and local logs`. When the
task itself failed and its worker said why (the Hermes adapter does when the
model provider refuses the call: `Hermes stopped: the model provider answered
HTTP 401 (unauthorized; check the model key)`), the worker relays that failed
result on stdout and still exits nonzero, so SuperBench checkpoints nothing.
The node carries the result's `handoff.error` as `detail.task`, beside
SuperBench's `detail.message`, and the card's sentence names it instead:
`Checkpoint failed: the task failed on the bench: "…". Nothing was reported as
a pass.` The reason is a closed form built on the bench (a provider status and
what it usually means, a timeout, or only that the harness stopped with an
error); the provider's own text, which can quote a key or a payload, never
leaves the bench, and the Hub bounds and redacts it as it does SuperBench's.

**A held lease.** When SuperBench refused the release too, the node's reply
also carries `detail.lease: "held"`. Before the board is told, the card gets a
second activity, `checkpoint.parked` with code `lease_held`, naming the bench and
the operator's path (BENCH_REGISTERED_LAUNCH.md, "A refused release"). A parked
reply that carries it parks as `node.state:<state>.lease_held` and says the same
once. After the board ended the run it parks as
`run_ended.node:<state>.lease_held` and is only logged. Seen on staging: a checkpoint
refused over a dirty tree read "the worker crashed or was stopped … (for example
by a SuperBench restart)", and no restart had happened.

A ruled refusal is held before anything is said. The attempt moves by
compare-and-set from the phase it was read in to `failure_pending`, with an
immutable `failure` cell: the code, the ruling, the sentence, the phase and the
node's exact reply. Only `prepare_pending` and `execute_pending` can take one;
they are the only phases that ask the node. Then, while the lease is still the
Hub's, the card is told (`checkpoint.failed` or `checkpoint.released`, with the
sentence and the code), the run is failed or released, and the attempt ends
`failed` with a `failure_report` saying how: `fail`, `release`, or
`lease_ended` when the board answered `STALE_LEASE` because it had already ended
the run, or `run_ended` when the board's run view said the run ended or its card
moved on before the board was told (below, "When the board ends the run").
`failed` is terminal, so the station takes a fresh checkpoint claim.
Any other answer from the board (a 5xx, `NOT_RUN_OWNER`) leaves the attempt in
`failure_pending`; the next pass tells the board again from the held failure and
never asks the node. An owner or admin may still settle a `failure_pending`
attempt as `retired`; a `failed` one cannot be settled.

Known limits: a `failure_pending` attempt whose profile is then replaced is
parked as `superseded.effect_possible` for an operator. A prepare whose
SuperBench reply did not parse answers `verification_failed` without journaling
the record terminal, so the node may keep that record's lease until a newer
attempt on the same card retires it.

### After a capacity refusal

A capacity release made the card claimable at once, and the next claim cycle
took it straight back: on staging one card reached 24 attempts in minutes, each
refused for the same capacity. The wait lives in the Hub
(`checkpoint-capacity-backoff.ts`) because SuperPipeline offers no per-claim
hint: its release takes no "not before" and its claim cannot exclude a card.
So the Hub cannot skip one card in a claim. It holds the station's checkpoint
claims instead, which fits the cause: SuperBench capacity belongs to the bench
host, so the next card on that host would be refused too. Ordinary claims go on,
and the claim cycle names the wait as `capacity.backoff`.

- The n-th capacity release in a row of a card holds the station for
  1 minute × 2^(n−1), at most 15 minutes.
- The 6th capacity refusal in a row of the same card is failed, not released:
  "SuperBench capacity was exhausted on 6 attempts in a row for this card". The
  board's retry policy and circuit breaker then decide, and a person sees it.
  The card's count starts again; the station still waits.
- Any other ending of the card's attempt (a pass, another failure) forgets it.

Known limit: the counts are process memory, so a Hub restart forgets them and a
card can take up to six more releases.

## When a completed run cannot be reported

A node's `completed` reply is turned into a settlement before the attempt
records `completed`. The builder (`checkpoint-report.ts`) reads only the
attempt's immutable cells and the node's journaled completion, so a refusal
there recurs on every pass: the run finished and can never become a pass. It
ends the attempt exactly as a definite node refusal does (`failure_pending`,
`checkpoint.failed`, `POST …/runs/:run/fail`, then `failed`), with code
`settlement.<why>` and the node's whole reply as evidence. It is never reported
as a pass.

| Code | Run is failed with |
| --- | --- |
| `settlement.unchanged` | "the run finished but produced no change, and this stage requires one" (every member's final checkpoint equals its start and the policy has `allowUnchanged: false`) |
| `settlement.task_outcome` | "the run finished but the task did not complete (`blocked` or `failed`)" |
| `settlement.foreign_source` | its result is not for the source this card admitted |
| `settlement.foreign_member` | a pushed checkpoint is not on this card's repository or branch |
| `settlement.completion`, `.retained_source`, `.shape`, `.size` | the completion, the retained prepared source or the settlement does not check out |

Everything else that can refuse after `completed` is transient or proves
nothing about the run, so it stays parked and names its reason:

| Where | Reason | Why it parks |
| --- | --- | --- |
| The current-authority re-read after the reply | `authority.changed`, `authority.raced`, `current.*`, `issuer.*`, … | Authority can come back; nothing about the run is decided by it |
| Committing `completed` | `ledger.phase`, `ledger.raced` | Another pass moved the row; the next pass reads it |
| `completed`: reading the source on the board | `service.status:<n>`, `service.timeout`, `service.error`, `service.grant`, `source.shape`, `source.binding`, `source.claim` | The board's answer, not the run's |
| `completed`: the run is no longer working on the board | `source.inactive` | Its heartbeat is stale or the run ended. A run the board definitively ended ends the attempt on the same pass (below) |
| `submission_pending`, `reported`: receipt and settlement | `service.*`, `receipt.shape`, `receipt.mismatch`, `service.receipt_missing` | A settlement may already exist; it is reconciled by receipt, never repeated or failed |
| Any phase: a retained cell missing or not matching | `retained.*` | Not reachable for a row the ledger wrote; parked for an operator, never guessed at |

`completed` and later phases rebuild the same settlement that already passed in
`execute_pending`, so they cannot hit a `settlement.*` refusal. The ledger
takes a failure only from `prepare_pending` and `execute_pending`.

A refusal on this path with no reason is refused by
`tests/unit/no-silent-catch.test.ts`: every `new CheckpointRefused(...)` in
the orchestrator, the builder and its checks, the source projection, the
service client and the ledger names one.

## When the board ends the run

The board can end an attempt's run while the attempt is unresolved, and then the
run never comes back: a claim binds a card only to a new run id. Parking such an
attempt waited forever, and because one unresolved attempt holds the station's
checkpoint claims (`attempt.unresolved`), one orphan held back every other card.
Seen on staging: a prepare the node refused (`refused`/`unavailable`), then the
card was moved off the bench stage. Every current decision refused `context`, the
node answered `refused`/`unavailable`, and the Hub parked it again on each
reconcile. Moving the card back did not help, since the old run was gone.

How a run ends on the board, and what the board then answers
(`checkpoint-run-ended.ts` reads `GET /v1/boards/:board/runs/:run`):

| What happened on the board | Run view (`GET runs/:run`) | Run verb (`heartbeat`, `fail`, `release`) | Hub reason |
| --- | --- | --- | --- |
| A person moves the card to another stage (`moveCard`), a route change or review cancels the card's wait, or a held approval is re-routed | `200`: the run stays `working`, the card's `currentRunId` is cleared (or later names a newer run) | Still accepted: the board checks only the run row. A `fail` or `release` acts on the card where it is now | `run.unbound` |
| Moved to a last stage nobody works (`done`), rejected at a gate | `200`, `run.unbound` (the run row is not ended) | Accepted, as above | `run.unbound` |
| The run was failed, released, blocked or submitted elsewhere, or completed | `200`: `status: "ended"` with its `outcome` | `409 STALE_LEASE` | `run.ended` |
| The heartbeat lapsed for 15 minutes and the board reclaimed it | `200`: `ended`, outcome `reclaimed` | `409 STALE_LEASE` | `run.ended` |
| The card was deleted (its runs are deleted with it) | `404 RUN_NOT_FOUND` (or `CARD_NOT_FOUND`) | `409 STALE_LEASE` | `run.not_found`, `card.not_found` |
| A run view carrying another lease epoch | `200` | `409 STALE_LEASE` | `run.epoch` |
| The run is another agent's | `403 NOT_RUN_OWNER` | `403 NOT_RUN_OWNER` | not an ending: parked |
| The board is down, redeploying or slow | `5xx`, timeout | `5xx`, timeout | not an ending: parked |

Only those explicit answers count. A 5xx, a timeout, a body that does not
parse, `NOT_RUN_OWNER`, or a view about another run or card is not an answer,
and the attempt keeps parking as before. The checkpoint client now keeps the
board's error code, from the closed set `STALE_LEASE`, `NOT_RUN_OWNER`,
`RUN_NOT_FOUND` and `CARD_NOT_FOUND` (at most 4 KiB is read, and nothing else
of the body is kept). Before, it dropped every error body, so not even a held
failure's `lease_ended` could happen in production.

**When the Hub asks.** On every recovery pass, before driving the attempt (and
before a superseded attempt is resolved); on any pass that is about to park in
`prepare_pending`, `prepared`, `source_pending`, `admitted`, `execute_pending` or
`completed`; in `failure_pending` before the board is told; and in
`submission_pending` only after an authenticated `CHECKPOINT_RECEIPT_MISSING`,
because a settlement that landed ends the run too. The read is a `GET`: it
neither heartbeats the run nor touches the card. Once the board has ended the
run, the Hub sends it no verb. A verb on an unbound run would act on the card
wherever it is now, and an activity would heartbeat it.

One activity is the exception, by an operator ruling: when the attempt is
retired and the bench had already pushed this card's work (the node's completed
reply, or the completion a `completed` or `submission_pending` attempt retained),
the card gets one `checkpoint.stopped` activity naming where it is, for example
`Run stopped because the card moved; partial work saved to card/<card id>
(<short sha>).` A run the board still shows working but no longer bound
(`run.unbound`) reads "the card moved"; any other ending reads "the card moved
or its run was ended". With nothing pushed, nothing is said. The activity is a
run verb, so the board accepts it only while the run is still `working`
(`run.unbound`); for a run the board has ended it answers `STALE_LEASE`, which
is logged and changes nothing.

**The current decision.** A node's current check that fails for an attempt it
matched now asks the board too. When the board says the run ended, the decision
answers `stale_owner` instead of `unavailable`, so the node retires its own
record: it releases what the record holds, sends one cancel for a launched run,
and never runs (BENCH_REGISTERED_LAUNCH.md, "Stale attempts clean up after
themselves"). A board that cannot be asked leaves it `unavailable`.

**The ruling.** The attempt reaches a terminal state, with the board's answer
and the node's reply as evidence. It is never reported as a pass.

| Phase when the board ended the run | What the Hub does | Attempt ends |
| --- | --- | --- |
| `prepare_pending`, `prepared`, `source_pending`, `admitted` (execute never sent: nothing ran) | Sends the node one `status`. The node's current decision is now `stale_owner`, so it retires its record and releases what it holds | `retired`, reason `run_ended`, on the same pass, whatever the node replied (an unreachable node included) |
| `execute_pending` (an effect is possible) | Sends the node one `status` on each pass. Under `stale_owner` the node journals a veto, sends one cancel for the run and releases the lease once the run's receipt is in | `retired`, reason `run_ended.stopped`, once the node's reply proves its record terminal (`refused` with `stale_owner`, `verification_failed`, `unsupported` or `capacity_exhausted`). Until then it parks as `run_ended.node:<state>` or `run_ended.node_unreachable`, and is not written to the card |
| `execute_pending`, the node never confirms | As above | `retired`, reason `run_ended.unconfirmed`, once the task's own timeout (`timeout_seconds`, from when execute was committed) plus 15 minutes has passed, since the producer stops a run at its timeout |
| `completed` (the node's run finished, no settlement sent) | Sends the node one `status` | `retired`, reason `run_ended` |
| `submission_pending`, the board holds no receipt | Sends the node one `status` | `retired`, reason `run_ended.unsettled`. A receipt the board holds is still recorded `reported`, even though the settled run has ended |
| `failure_pending` | Tells the board nothing | `failed`, `failure_report` outcome `run_ended`, carrying the board's answer |

`retired` and `failed` are terminal, so the station is free. A recovery pass
that ended the attempt returns nothing, and the cycle goes straight on to a fresh
checkpoint claim for any card; a pass that ended it inside a drive reports
`released`, and the next cycle claims. An unresolved attempt whose run has ended holds the station's claims
for at most one pass. The one exception is after execute, while the node is still
winding the run down, and that wait is bounded by the task's timeout plus the
grace period. The node's bench is per card (its key is the tenant, board and
card), so nothing it still holds for the ended card blocks another card's
prepare.

**A board cancel, at each phase.** A cancel on the board is a person moving the
card off the stage, a review or route change cancelling its wait, or the card
being deleted. Each is `run.unbound` or `run.not_found` on the next read.

- Before execute was sent: the next pass (at most one backoff later) retires the
  attempt (`run_ended`) and tells the node, which releases its lease. Nothing
  ran, and no source admission or execute is sent afterwards.
- While the run executes: the node's next current check, before or after any
  effect, gets `stale_owner`. The Hub's next pass tells the node, which sends one
  cancel and releases the lease once the run's receipt is in. The attempt ends
  `run_ended.stopped`, or `run_ended.unconfirmed` past the timeout and grace.
  The run's result is never settled.
- A cancel that wins the run's finalization race leaves no receipt at all:
  SuperBench refuses to store the reply (benchd: `receipt_save_failed`,
  "operation cancellation requested") and the run's lookup answers
  `cancel_requested` for ever. Seen on staging: the node waited for that
  receipt, answered `pending` on every pass (`run_ended.node:pending` for over
  20 minutes) and kept the stopped lease. The node now ends its record once the
  bench shows its own lease `stop_requested` with the execution `stopped`, and
  releases that lease with its own token (BENCH_REGISTERED_LAUNCH.md, "Run
  cancelled before its reply was stored"). Its next reply is `stale_owner`, so
  the attempt ends `run_ended.stopped`.
- After the node completed, before the settlement: `run_ended`; nothing is
  submitted.
- With a settlement pending: if the board holds its receipt the attempt is
  `reported` as usual; if not, `run_ended.unsettled`.
- With a held failure: `failed`, outcome `run_ended`; the board is not told.

Known limits. A node that cannot be reached when a nothing-running attempt is
retired keeps that card's record and lease until its next `status` or a newer
attempt's prepare on the same card: the Hub's current decision answers
`stale_owner` for a retired attempt from then on, so either one retires it. A
card moved off the stage leaves the board's run `working`, and once the Hub stops
heartbeating it the board reclaims it after 15 minutes. That reclaim (like any
verb on the run) acts on the card where it then is. This is SuperPipeline's
behaviour, not the Hub's.

## Waiting on the node

A coordinator call that outlasts the Hub's wait is not a failure. The broker
sends no cancel, so the node carries on; the attempt stays parked on its phase
(`uncertain`, reason `node.call.timeout`) and a later `status` reads what the
node did. The waits fit each operation (`checkpoint-node-call.ts`): `ready`
5 seconds, `status` 60, `prepare` 120 and `execute` 60. An execute runs the
task for up to its whole timeout, so the Hub never waits for it: a longer run is
read with `status` on later cycles.

Real runs take longer than the 60 second execute wait, so a run still going is
said on the card as progress, not as a park: once per attempt, a
`checkpoint.running` activity reading "the task is still running on the bench;
its result is checked again shortly" (parameter `waiting: true` and the reason).
That covers an `execute_pending` park on `node.call.timeout` and on a bare
`node.state:pending` (no detail: no held lease and no message). Every other park
keeps its `checkpoint.parked` wording.

Nor does the loop treat it as a fault. A run still going comes back with a
recheck (`DispatchResult.recheckMs`, 5 seconds, capped at 10): the loop waits
that long and reads the run's `status` again, with no fault backoff, no streak
and an info line ("the checkpoint task is still running; checking again
shortly"), and the attempt's own recover backoff waits the same 5 seconds. Every
other park keeps the 30 second backoff, doubling to its ceiling, and its warning.

The node waits up to 20 seconds (15 for the headers) for each of the Hub's
current decisions, and asks for one before and after every effect. A decision
re-reads issuer authority, exchanges a plane grant and reads the run on the
board, so it takes seconds; the decision carries its own two-second expiry,
which the node checks on arrival. The organization plane's key set is shared
across decisions (`sharedPlaneVerifier`) rather than fetched for each one;
authority reads and grant exchanges stay fresh on every decision by design.

## An attempt under a replaced profile

A node build or pin change replaces the installed profile while an attempt made
under the old one is unresolved. The ledger never relabels that attempt and never
lets the change make it disappear; it is resolved, with evidence, as follows.

- **One unresolved attempt per station.** The node holds one bench per station and a
  newer prepare waits on the older record, so while an attempt is unresolved the
  station's new checkpoint claims wait. The wait is logged as a checkpoint refusal
  (`uncertain`, reason `attempt.unresolved`, or `recover.<code>` when recovery itself
  threw), rate-limited like any other. Ordinary claims continue in the same cycle.
  Re-driving the attempt backs off from 30 seconds to 5 minutes. Each re-drive
  heartbeats the run, and SuperPipeline reclaims a run after 15 minutes without
  one, so the ceiling stays well inside that window.
- **Superseded is a definite change.** When a loaded installation holds a different
  profile for the attempt's station, the Hub's current-decision answers `stale_owner`
  for the old attempt, so the node retires its own record (it releases what the
  record holds and never runs). That holds after the node itself was upgraded too:
  a node whose registry no longer serves the attempt's target still answers its
  `status`, with `stale_owner`, when nothing launched (BENCH_REGISTERED_LAUNCH.md). A profile file that failed to load is never treated
  as superseded.
- **The Hub retires it when the evidence proves nothing is outstanding.** Only in
  `prepare_pending` or `prepared`, where no source was admitted to SuperPipeline and
  no run could launch, and only on the node's `status` for the attempt's exact
  retained identity: `unknown` while `prepare_pending` (the node never journaled the
  prepare), or a terminal `refused`/`stale_owner` (the node retired its record). The
  attempt ends in the terminal phase `retired`, with an immutable `retirement` holding
  the reason (`superseded.no_record` or `superseded.node_retired`), the phase it left
  and the node's exact reply. The station then takes a fresh claim under the current
  profile.
- **Everything else stays parked, named**, logged once per attempt and reason as
  `superseded checkpoint attempt parked; an owner or admin can settle it`
  (`superseded.effect_possible`, `superseded.node:<state>`,
  `superseded.node_unreachable`). A superseded attempt whose run the board has
  ended is ended first, as any other ("When the board ends the run").
- **An owner or admin settles a parked attempt explicitly.**
  `fleet bridge checkpoint-attempts` lists the workspace's unresolved attempts with
  their phase, `superseded` and `effectPossible`.
  `fleet bridge checkpoint-settle ATTEMPT --evidence "…"` ends one as `retired` with
  reason `operator`, the operator's principal and their evidence (what they checked
  on the node and the board, and why nothing is still running). It is audited, and
  afterwards the Hub answers the node `stale_owner` for it. The API is
  `GET /api/admin/checkpoint/attempts` and
  `POST /api/admin/checkpoint/attempts/:attemptId/settle` with
  `{"confirm": "<attempt id>", "evidence": "…"}`.
- **Nothing is deleted.** `retired` and `reported` are terminal, a retirement can
  never change, and every evidence cell the attempt already held stays as it was.

The `bridge-checkpoint` structured logs report profile availability, successfully
committed attempt phases, and parking with closed refusal codes. Work identifiers
allow an operator to join the phase to its ledger row. These log events exclude
private configuration paths, bodies, credentials, worker handoff and raw errors.
A parked message is not proof of fencing, release or successful settlement.

The service client validates raw strict receipts from the dedicated
`POST /checkpoint-settlements` and `GET /checkpoint` endpoints. It recognizes only the
exact authenticated `CHECKPOINT_RECEIPT_MISSING` response as receipt absence.
Disabled, unknown-board, expired, foreign, malformed or lost responses park.
A refused answer parks with reason `service.status:<status>` and logs that status
and the board's error body, bounded and redacted (`checkpoint service:
service.status`); a timeout is `service.timeout`. The body is only logged: it
decides nothing and never reaches the wire.
The entire canonical submission, including handoff/outcome, must be retained
before POST; both its request digest and the observation-only report digest are
checked on a receipt. No child execution is repeated to recover a report reply.

The Node now derives canonical source request/receipt hashes from its exact saved
private exchanges. Existing raw request/response and Go typed body digests retain
their original meanings. The report builder checks complete/released/stopped
results, exact retained start/prepared evidence and server-owned repository
mapping; arbitrary repository hashes never authorize logical repositories.
Untrusted child handoff remains text and is not source attestation.

An explicitly installed profile now selects the dedicated production port in the
bridge loop before an ACP claim. It checks the selected enrolled Node's actual
managed coordinator/worker/registry pins and uses the station-plane issuer client
without a Salaam readiness requirement. No profile is shipped or installed.
Immutable SQL phases retain source, execute body, completion and the complete
settlement before their effects. Only the original successful reservation or
phase compare-and-set may send Prepare or Execute. Restarts read exact Status;
an unresolved old attempt blocks a fresh claim and cannot adopt a new owner.

One recovery re-sends a prepare. When a recovered `prepare_pending` attempt's
Status answers `unknown`, the node holds the attempt's exact prepare but never
resolved it: its own current check or its read-only bench choice failed inside
the prepare, so it invoked no source effect. The Hub then re-sends the identical
retained prepare bytes, never new ones. The node's intent accepts only those
bytes (same digest), resolves the choice once and hands off its effects at most
once; the send is current-gated on both sides. A `pending` Status is
re-sent the same way: the node resolved the prepare, but its launch stopped part
way (for instance its own current check failed after the reservation was
journaled, before any SuperBench call). A registered launch journals every step
before it leaves and never sends one twice (a sent step is recovered by receipt
lookup only), so the identical prepare resumes it; a grouped launch only reads
status. A `refused` Status is only read.

After a lost settlement POST reply, recovery first reads the exact historical
receipt. Only an authenticated `CHECKPOINT_RECEIPT_MISSING` reply permits
resubmission of the complete retained settlement. Reconciliation checks the
current run and heartbeat, re-derives the same report from the retained strict
completion, verifies the active exact admitted source, and rechecks the current
workspace/issuer authority before POST. The service rechecks its selected
reporter and atomically settles the identical submission once. This also closes
death after retaining `submission_pending` but before sending POST. A timeout,
disabled service, revoked grant, replaced source or ended run remains parked.
No child is repeated and no new report or request ID is substituted. Historical
receipts remain readable without requiring a still-active run. A cancelled or
failed task does not become a pass.

Authenticated database/broker tests and actual managed Node/service execution
are distinct gates; typed fixture observations do not prove remote fencing.
The complete deployed Hub/Node/source-admission/report path, uncertain-operation
cancellation/reconciliation, acceptance of the remaining wire and issuer
contracts, and operator provisioning remain required. This checkpoint does not enable the
Developer Experience pilot or satisfy native laptop preparation. No generic ACP
fallback or adoption of replacement-owner output is allowed.

## What a roster edit changes

The attempt's retained authority pins the roster row by `rosterRevision`, a
`roster:<sha256>` digest of the row's fields that bear on authority: board,
station, enabled, permission mode, profile and plane credential source. Loop
tuning (`max_concurrency`, `permission_wait_ms`) and the other paths' tokens are
not in it. Editing them restarts the bridge loop, as `updated_at` makes it, but
the attempt stays current. Editing an authority field ends the attempt's
authority (`authority.changed`, and the node's current check answers
`stale_owner`).

Attempts reserved before the digest retain the row's `updated_at` instant
instead. Such an attempt still matches when that instant is the only change:
every other retained field, and the authorization snapshot digest recomputed
over it, must be exactly equal. The pins the Hub reads anyway (board, station,
enabled row, profile) still hold. Only a mode or credential-source edit goes
undetected for these older attempts.
