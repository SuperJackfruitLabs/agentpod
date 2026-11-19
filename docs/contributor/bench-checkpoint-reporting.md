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

Profiles are an immutable process snapshot, loaded lazily once per configured
path, including a failed load. Editing, repairing, replacing or deleting the same
file does not reload that snapshot: restart the Hub to apply it. A changed server
configuration path selects a new snapshot; no file watcher or periodic read runs.
Roster loop construction selects its dedicated runtime once. Every operation still
rechecks the literal flag, current issuer/control pair, selected station/node,
run/epoch and policy around awaits; snapshot caching does not cache authority.
These settings provision no credentials, policy or capability; no profile or
environment setting is installed by this change.

The `bridge-checkpoint` structured logs report profile availability, successfully
committed attempt phases, and parking with closed refusal codes. Work identifiers
allow an operator to join the phase to its ledger row. These log events exclude
private configuration paths, bodies, credentials, worker handoff and raw errors.
A parked message is not proof of fencing, release or successful settlement.

The service client validates raw strict receipts from the dedicated
`POST /checkpoint-settlements` and `GET /checkpoint` endpoints. It recognizes only the
exact authenticated `CHECKPOINT_RECEIPT_MISSING` response as receipt absence.
Disabled, unknown-board, expired, foreign, malformed or lost responses park.
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
