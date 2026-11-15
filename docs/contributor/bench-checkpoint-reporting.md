# Proposed dedicated checkpoint reporting

This work follows the proposed charter decision
`2026-11-15-checkpoint-settlement-needs-a-coordinator-grant.md`. It enables no
capability, bridge constructor, service grant, stage policy or pilot. The accepted
host-local SuperBench contract does not accept this cross-product authority.

The internal Hub source client uses the existing organization issuer's service
token endpoint and verifies its EdDSA signature, audience, organization, service
principal, expiry, entitlement and operation scope. The service credential stays
in the Hub. Source HTTP calls have fixed server-selected origins, no redirects,
bounded bodies and static errors. A lost admission response is uncertain; it is
never a reason to run the child again. No settlement route is invoked yet.

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

The remaining path requires an authenticated coordinator broker verb and Node
handler, real registry/current/admission gates, a durable exact attempt and
request ledger, canonical source digests derived by the Node from its saved
private exchanges, and a retained immutable settlement body before submission.
Existing raw request/response hashes and Go typed request digests cannot be
relabeled as the settlement contract's canonical hashes. All source and
completion joins must finish under fresh issuer, station, occupancy, control-pair,
policy and run checks. Unknown execution or cancellation remains parked; no
generic ACP fallback or replacement-owner adoption is allowed.
