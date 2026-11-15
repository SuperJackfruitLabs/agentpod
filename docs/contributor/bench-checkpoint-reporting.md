# Proposed dedicated checkpoint reporting

This work follows the proposed charter decision
`2026-11-15-checkpoint-settlement-needs-a-coordinator-grant.md`. It enables no
capability, installed configuration, service grant, stage policy or pilot. The accepted
host-local SuperBench contract does not accept this cross-product authority.

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

The canonical goldens are copied unchanged from Treaty revision
`d578c7e3ed0709cf7d6d38f7545edacab1691201`,
`fixtures/superpipeline-run-checkpoint/canonical.json`, SHA-256
`e199f937c17a28edf8b0ab7285870faf0880dba23ccf15f51604e183052e7fb0`.
The source transport follows SuperPipeline source owner
`e78e1bb8414b6a2127b666348d62d1c06571714c`. These remain proposed contracts.
Tests import plain fixtures, never another product's TypeScript.

The default-off Hub callback and immutable attempt table now retain the original
prepare request/selected authorization before Node effects. The callback verifies
the actual enrolled Node credential and compares fresh database occupancy, issuer
control-pair and SuperPipeline pending/current-source observations after awaits.
Private physical profile configuration is read only under the literal proposed
flag; no configuration is supplied or enabled by these source changes.

`PROPOSED_CHECKPOINT_COORDINATOR` must equal the literal `true` before the
Hub reads any dedicated profile. Unset or other values keep this path disabled.
`PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE` selects an absolute physical
JSON file, at most 64 KiB, in a private directory. The file and directory must be
owned by the service user or root and inaccessible to other users; symlinks are
refused. The versioned profile pins the issuer organization, both tenant ID
spaces, selected workspace and agent, repository mapping and installed Node,
worker and registry digests. Missing or invalid configuration refuses dedicated
work. These settings provision no credentials, policy, capability or acceptance;
no profile or environment setting is installed by this change.

The service client uses the proposed owner service revision
`7d87ef6a964b54062f9af2e610a122263fb0242f`: raw strict T37 receipts from
`POST /checkpoint-settlements` and `GET /checkpoint`. It recognizes only the
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
cancellation/reconciliation, accepted authority decisions and operator
provisioning remain required. This checkpoint does not enable the
Developer Experience pilot or satisfy native laptop preparation. No generic ACP
fallback or adoption of replacement-owner output is allowed.
