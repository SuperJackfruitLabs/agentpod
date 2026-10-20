# Salaam durable work: contract assessment

Status: implementation packet and proposed handshake, 2026-10-20. This is not a
claim that M21 or live Superpipeline acceptance is complete.

## Reviewed sources and decision status

- AgentPod base `1393de17dd4d603dd5c3eb42beb7d0de15fa5673`:
  `services/bridge/dispatch.ts`, `ledger.ts`, `superpipeline.ts`,
  `services/salaam-authority.ts`, and `packages/contract/src/salaam-authority.ts`.
- Salaam `6d4fd50468729a3aa3037a60af417d9057028aa7`:
  `src/agentpod-protocol.ts`, `agentpod-authority.ts`, `task-work.ts`,
  `task-verification.ts`, and `acp.ts`.
- Superpipeline `9406fcba81cb006a98d6a41c1c33a2512a9a664a`:
  `apps/api/src/board/board-do.ts` owns run authorization, completion rules,
  approval subjects, and gate advancement. This is Forge-primary source.
- Charter `f3a7652392ff967c5da7e297099a7cb64a30e5dc`: the 2026-09-02
  capability/affordance/authority distinction is **Decided**. The 2026-09-29
  evidence-joins record still says **Draft, not accepted**; its amended header
  does not make every proposal accepted. The 2026-10-04 Witness ownership
  decision is **Decided** and builds on parts of that evidence model. Existing
  run joins below are implementation facts, not a new authorization decision.

## Implemented repair

A timeout or ended session previously reached `recordProduced` before the failed
turn was classified. If the board's `/fail` response was lost, the generic error
exit preserved that `produced` row. The next claim could replay partial prose as
successful output.

Terminal failure is now written as `abandoned` before any remote failure report.
The attempt is failed and session shutdown receives the failure reason. The
failure path never writes a completion handoff. Tests reproduce both terminal
cases with a lost failure response and assert no replayable output or completion
request. This does not change other harnesses' successful replay contract.

## Existing boundary and remaining gaps

AgentPod owns authenticated station/occupant admission. Its canonical
`SalaamAuthority` already binds organization, principal, node, station, occupancy
epoch, Hub session, workspace, and `{source, id, epoch}` work run. The bridge passes
Superpipeline run/lease epoch into session creation; board heartbeat must succeed
before execution renewal. Salaam checks its own bounded admission lease.

The bridge still interprets ACP idle as a yielded answer. Its existing generic
cross-run replay finds produced output by card, excluding the current run, without
revalidating payload or fresh checks. Neither behavior is a valid strict Salaam
completion protocol. The current `askTheHuman` initially selects the last unseen
elicitation, then pins its ID; it does not bind the first selection to an exact
Salaam operation. These gaps remain open.

Salaam has one durable task per session and transactional creation. Its task
verification checks workspace revision/digest, plan revision, accepted checks,
actual command evidence, unresolved operations, and unfinished children. A stored
completion alone is insufficient: `TaskVerification.view()` must report it fresh.
That verifier currently depends on the coding workspace executor; protected
station execution needs an explicit compatible verifier, not a fabricated receipt
or a fallback to model text.

## Proposed strict handshake (not yet implemented)

Canonical AgentPod contract should negotiate a versioned strict work capability
through the authenticated node/daemon path. Select it only for an observed Salaam
runtime supporting the whole protocol. Unsupported versions fail before claiming
strict work; other harnesses retain their existing behavior. ACP metadata, a
requested harness string, a model tool response, or a profile cannot grant it.

1. **Admission** carries a stable request ID, complete existing authority binding,
   board/card/run/lease identity, canonical work-input digest, explicit task plan,
   acceptance definitions, and bounded progression policy. Input digest includes
   instructions, references, incoming handoff, required checks, and execution
   policy. It excludes credentials. Bind the admitted principal and occupancy;
   never infer them from model content.
2. **Daemon acceptance** atomically creates or finds the single local task for
   that work-run binding, returning task/session IDs, immutable binding digest,
   plan revision and request receipt. Same request plus changed input is a
   conflict. A new lease/run cannot adopt an old task or old completion as fresh
   authority. Existing stopped-resource and uncertain-effect fences still apply.
3. **Progression ownership** stays in one place: the bridge owns claim/heartbeat
   and board reporting; Salaam owns explicitly bounded task steps. Disable
   competing local schedules for the bound task. A board heartbeat failure must
   stop renewals, and no new local grant may survive lease expiry or revocation.
4. **Decision requests** name work binding, task/plan revision, operation ID and
   digest, immutable request ID, offered option IDs, and expiry. Persist the exact
   Superpipeline elicitation ID returned by its producer. Answers from console,
   TUI or Matrix must match that full binding and current authority before the
   existing operation consumes approval. Reverse-order questions and stale
   answers must never select a different operation. Do not grant from "latest".
5. **Completion** returns a typed outcome and immutable evidence reference,
   bound to run/lease, principal, task/plan and actual integrated workspace
   revision/digest. Required checks must be fresh actual receipts, not merely
   `attempt.state=completed`, ACP idle/end-turn, successful MCP transport or prose.
   Exceptions, partial results, blocked work, uncertainty and failure stay
   distinct. Recheck immediately at the effect/report boundary after awaits.
6. **Report recovery** persists completion intent and digest before sending the
   board verb. On lost response, read the original run and compare its stored
   outcome/handoff before resending; do not claim a new run and replay old success.
   A reclaimed run may inspect the old output as a candidate only. Fresh admission
   and verification are required before it can advance anything. Mismatched input
   or unresolved effects block new work rather than trigger a blind second write.

The next foundation packet defines `SalaamWorkAdmission` version 1 in the canonical
AgentPod contract and exports pure shape, independent-binding and exact-replay
checks. It is deliberately not advertised in runtime capabilities or routed to
execution. Its JSON corpus lives at
`packages/contract/src/fixtures/salaam-work-v1.json`; the daemon must consume the
same cases before this can be enabled. No daemon consumer pass is claimed yet.

The minimal admission has `version`, `request_id` (UUID), full existing `binding`,
and `work` with `board_id`, `card_id`, `stage_key`, `input_digest`, `plan_digest`.
All objects are strict. Work run source must be Superpipeline; run, board and card
prefixes follow its canonical base62 ID contract (`card_`, not the old bridge
fixture's `crd_`). Wire lengths are explicit limits of this opt-in transport.
A producer must derive digests from actual admitted input and task-plan bytes;
matching two attacker-supplied strings is not validation. This packet does not
specify a new canonical payload encoder or duplicate Salaam's task-plan schema.

`checkSalaamWorkAdmission` compares against an independently trusted full binding
and work definition. `checkSalaamWorkReplay` accepts only the original complete
request, including run, lease and principal. Neither function persists records,
grants execution, checks live authority or authorizes receipt reads. Consumers
must preserve root/principal read scoping, check saved requests before new mutation
checks, and commit original request plus one-run/task mapping atomically.

Remaining consumer integration must adapt protected station receipts: StationWork's
check input/configuration/root digests and StationFiles' actual tree digest must
produce fresh TaskVerification evidence. Do not pretend a coding Docker executor
exists. Include station calls and uncertain stop/effect state in completion's idle
closure. Cross-product producer and consumer changes must land together with the
versioned rejection corpus.
Old or omitted capability cannot silently opt a Salaam station into generic
unverified completion. Existing legacy produced rows need explicit reconciliation
when entering strict mode; do not reinterpret them as verified receipts.

## Required acceptance before milestone completion

- Real daemon/node/Hub restart and disconnect preserves one run/task/request;
  stale lease, occupant, principal, plan or input cannot dispatch.
- Actual protected station integration produces a fresh passing check and only
  then advances a required stage. Changed bytes, failed checks, unintegrated
  proposals, exceptions and false final answers do not.
- Original-run lost-complete-response recovery, changed-payload reclaim, uncertain
  external effects, and reverse-order human decisions do not duplicate work.
- TUI and console exercise the exact decision contract. A live Matrix rehearsal
  requires separate explicit authorization to send messages.
- Named disposable Superpipeline/Claude acceptance verifies deployed producer and
  consumer revisions. Offline database fixtures prove only local conformance.

## Private producer/control packet

The closed `SalaamWorkPayload` now carries the admission, admitted input
(instructions, ordered references, incoming handoff) and a fully expanded explicit
plan. The Hub producer computes both SHA-256 digests from recursively sorted-key
JSON. All plan defaults must already be expanded; acceptance commands, deliverables,
step dependencies/checks and limits are covered by the plan digest. Unknown
input/plan fields are rejected rather than silently losing policy intent. The
producer does not obtain identity or authority from model metadata.

`fixtures/salaam-work-payload-v1.json` supplies independently computed bytes/digests
for the daemon's normalized-plan parity check. The native `Client.WorkAdmit` sends
only over the existing private daemon control client, binds the response to an
independently obtained admission/session/request/digest, and rejects successful
transport with another run's receipt or a completed result. It does not retry or
renew authority. Receipt recovery is allowed to reach the daemon with a saved
owner binding; fresh grants remain the daemon's responsibility.

This packet is deliberately **not wired into the gateway or bridge** and is not
advertised as a runtime capability. The installed node cannot yet dispatch strict
work through this method. Remaining implementation must persist producer input and
request identity in the bridge, derive independently trusted board/card/stage from
its ledger, route authenticated control, verify the actual protected station, and
implement exact human decisions and original-run reporting recovery. A closed
schema and an HTTP test server are not a full authenticated or deployed proof.

## Durable owner and gateway integration packet

Migration 0104 adds an immutable run/session/request owner record, with restrictive
foreign keys and checked payload joins. The internal bridge reservation uses the
actual claimed run and read context, compares card/stage/lease, locks its dispatch
and session, derives input bytes from card/stage/comments/references/handoff, and
persists the complete payload before delivery. Concurrent callers obtain one
request. A changed payload/session/lease conflicts. Generic output and report
writers cannot mark a strict owner successful; generic card replay refuses any
strict ownership and claim replay cannot reset its outcome or replace its lease.

The authenticated node gateway now handles `salaam.work-admit`, obtains independent
private daemon authority status and forwards the stored payload. The Hub delivery
path uses only its persisted payload, validates every receipt join, retains the
same request after response loss, and caches admission acknowledgement only. A
cached acknowledgement is readable by its session owner without renewing any
execution grant. It cannot advance a board or imply successful work.

This supersedes the earlier packet's “not wired into gateway” limitation. Strict
bridge selection remains disabled/unadvertised: actual daemon composition,
protected fresh verification, exact human decisions and original-run completion
reporting must pass before selecting this path automatically. Tests use real
isolated PostgreSQL with a synthetic organization plane and synthetic broker/HTTP
receipts. They do not prove the entire deployed transport or a real station.

## Exact human decision packet

`SalaamWorkDecision` pins the work request, authority digest, task/plan, operation
and approval ID/digest/revision, immutable expiry, question and approve/deny offer.
It comes from private daemon discovery, not generic ACP event metadata. Migration
0105 reserves the full decision before publishing its question. The producer gets
`strictDecision` version 1 with request ID, decision digest and expiry, plus the
exact question/options and `signal: select`.

Only an exact returned `elicitationId` and matching strict correlation is accepted.
Reads match that ID, run/card/stage/lease, full offer and strict binding; there is no
“latest” selection. Original producer requests and immutable answers survive lost
responses. Current execution authority and expiry are checked before delivery;
the daemon still owns final fresh approval consumption. Saved acknowledgement
receipts remain scoped and validated, never treated as new grants or completion.
Old producer replies without strict fields fail closed. Legacy harness question
behavior is unchanged.

The producer implementation is private Forge Superpipeline `fa7d735` (not deployed
by this work). Its accepted strict ask response is an ordinary activity result
with exact `elicitationId` and `strictDecision`; matching fields are on run-read
elicitation records. It requires the original live run/lease and unexpired question
for human answers, while exact creation retries are historical reads. AgentPod's
current database tests use a synthetic producer and node response; actual cross-
product and daemon decision acceptance still must pass. No Matrix messages were
sent, and strict automatic bridge selection remains disabled.

## Original-run completion recovery packet

Migration 0106 reserves a structured report intent, completion receipt and handoff
before any board completion call. Fresh daemon `work-completion` observations must
match the original work request, task/plan and authority. Before reporting, the
bridge obtains fresh protected verification again; a changed receipt blocks the
old intent. The handoff is constructed from the exact stable receipt and report
request ID, not model final text or arbitrary caller JSON. The report explicitly
uses `outcome: pass`.

Every retry first reads the original run. An ended run is acknowledged only with
matching run/card/stage/lease, `outcome: completed`, original verdict
`{met: true, outcome: pass}`, and exact original run handoff matching the durable
intent. Neither HTTP success nor a current card's newer handoff is evidence of
that report. A successful lost response can therefore reconcile after revocation
without another execution/verification grant or write. A changed lease, missing
original-run fields, another verdict or output, and unverified daemon output all
fail closed. Generic cross-run replay remains blocked.

The required producer read is Forge Superpipeline `c62b7dce`: additive
`run.handoff` and `run.completion` preserve original-run facts even after another
run changes the card. Older producers lacking these fields cannot use strict
reporting. Producer strict-decision corpus `722f8f0` is mirrored byte-for-byte in
`superpipeline-strict-decision-v1.json` and consumed by the AgentPod parser tests.
The two Salaam payload/decision fixtures now match its formatted mirrors exactly.

Database report tests still use a synthetic fresh daemon receipt and synthetic
board client. They prove durable reservation/reconciliation, loss/conflict and
scope behavior, not actual native verifier execution or deployed acceptance.
Automatic bridge selection remains disabled until the full milestone chain is
proven. The new native completion forwarding branch still needs the consolidated
native test run after the Mac's disk-pressure cache cleanup.

### Strict bridge selection and bounded progression

The production bridge probes the private node `work-capability` route before a
Salaam claim. Only version 1 with the explicitly enabled protected daemon backend
selects strict work; unsupported Salaam stations fail closed. Other harnesses keep
the existing ACP dispatch behavior. A strict card must carry `spec.salaam` with
`version: 1` and a fully expanded `plan` matching the work contract. The bridge
never turns model prose or an ordinary ACP turn into that plan or completion.

Before claiming another run the bridge reconciles its durable original session.
It heartbeats the original board lease before renewing execution, grants exactly
the original plan's bounded steps using its saved request identity, and polls
private task status and exact human decisions. Progression uses the daemon's
existing task driver. Successful status still requires independently fresh
protected completion and original-run report verification. Lost transport replies
preserve original ownership for recovery; authoritative lease loss, terminal
failure and exhausted bounds attempt explicit revocation. Unknown outcomes cannot
open replacement work. Daemon progression remains an explicit service opt-in;
component fixtures do not establish a deployed capability or milestone acceptance.

Strict work requires the reviewed schema6 host manifest opt-in. Native startup
continues to delegate the complete manifest/pin/health comparison to the reviewed
absolute host CLI, then requires its startup receipt to include exact
`strict_work: {version: 1}` before probing capability. Missing/null remains valid
for ordinary disabled hosts but cannot enable strict bridge work. Unknown versions
and fields fail startup receipt validation. A private endpoint without reviewed
host startup configuration is insufficient to advertise strict work.

Fresh status/completion scans use bounded 120-second native transport (125 seconds
at the Hub). These timeouts do not change the 90-second execution lease. During an
awaited scan the strict controller independently heartbeats the original board run
and then renews its execution lease, serially every 15 seconds. It waits for any
in-flight renewal before accepting a result; renewal failure wins over a late
successful observation. Timers end before reporting to the board, so an ended run
is not accidentally renewed. Historical original-run report reconciliation still
requires no new execution grant.

### Explicit terminal settlement of never-dispatched work

An admitted task whose original run expired before progression is retained. An
operator may quiesce its controller and invoke `settleNeverDispatchedSalaamWork`
with the original run and one durable recovery request ID. The Hub verifies the
exact stopped authority and original producer run/card/stage/lease. A still-working
original run is failed through its normal authenticated producer API; a lost reply
is reconciled by reading that original run. The producer's immutable ended/crashed,
ended/released, or ended/reclaimed projection proves non-success, not who caused it.
A reclaimed original run can have a successor; settlement only retires the stopped
original owner and never authorizes actions on the successor.

Migration0109 stores recovery intent, immutable producer terminal projection and
exact daemon cancellation receipt on the original owner. The private native
`work-settle` route checks the exact revoked/stopped owner, and the daemon refuses
any task with attempts, operations, checks, grants, children or unresolved resources.
Only a confirmed `cancelled` / `never_dispatched` receipt retires the dispatch as
abandoned. The owner and task remain present. Unknown responses preserve the fence;
retry uses the original request and terminal digest. This action is not automatic
polling, model permission, a new lease, or successful completion.

Candidate upgrades apply migration0109 only to the isolated candidate database
through the ordinary migration helper after a private backup. Updated Hub, native
node and reviewed Salaam daemon must be deployed together before invoking recovery.

The concrete operator entry is the existing guarded admin surface:
`POST /api/admin/bridge/agents/:key/salaam-settle` with only `runId` and `requestId`.
Restart Hub with `ENABLE_SUPERPIPELINE_BRIDGE=false` first; roster pause alone does
not quiesce an in-flight controller. The exact operator-owned roster must be enabled
for normal short-lived credential resolution while global loops remain disabled.
No credentials are returned. Keep the same request ID after an uncertain response.

Expired unanswered decisions use a separate recovery receipt. The controller
recovers a lost producer question receipt through an exact original-run GET;
it does not repost an expired question or deliver a late answer. It stops the
original execution, fails or reads back the original producer run, and requests
`work-expire`. The daemon must prove the exact approval expired unanswered, its
operation was cancelled before dispatch, and all owned resources stopped before
cancelling the task. The durable owner records `expired_approval_unapplied`, not
`never_dispatched`; request mode, decision, task, run epoch and terminal projection
remain immutable across retries. Only that receipt retires the old owner for a
normal subsequent claim. Unknown resources and mismatched receipts keep the fence.
