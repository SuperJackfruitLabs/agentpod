# Proposed dedicated checkpoint coordinator wire

Status: **proposed, data-only, disabled**. These strict TypeScript schemas and
standard-library Go parsers are an owner-first checkpoint for a future dedicated
adapter. No broker verb, station capability, heartbeat readiness, handler,
constructor, service grant, deployment setting or board policy is enabled.
Use the existing authenticated gateway/broker request and response envelope; the
objects here are its proposed inner data. An unknown operation/version refuses.
It never falls back to ACP, Salaam or an ordinary agent command.

The accepted 2026-11-14 SuperBench lifecycle decision permits opt-in host-local
Unix service consumption. The 2026-11-15 coordinator-grant and operation-bound
cancellation decisions remain proposals. This extension does not accept those
agreements or create another audience/issuer. Linux `linux-cgroup-v2` is the only
proposed mode here; it does not fulfill native laptop preparation, and neither a
mode string nor a SHA proves that containment was configured or succeeded.

## Boundary and identity

`agentpod.bench-coordinator.v1` distinguishes the proposed adapter data version
from `superbench.v2` (the bench protocol), the packaged worker version/digest,
and the coordinator implementation digest. A target also pins the selected
node, authoritative host and trusted registry revision. Actual ready answers
must come from an authenticated current node after verifying that installed
implementation, worker, registry and common control pair. Merely parsing a
ready object never advertises readiness or creates authority.

Owned operations bind tenant, board, card, stage, run, epoch, executor, station,
node, attempt, policy and selected control identity. `control_grant_id` preserves
the private observation's historical field name: it is an opaque local
selected-authorization snapshot, **not an issuer grant identity**. The real
adapter must derive this snapshot from the actual selected authorization; a
caller-provided identifier or digest cannot certify it. Reporter service
credentials remain in the Hub and never enter node DTOs, worker context,
harness configuration, environment or child-readable files.

A prepare request selects a local trusted task profile and bounded prompt;
trusted node configuration resolves executable, arguments, paths, repository
URLs and environment. None of those private values, continuation tokens,
`SourceSpec`, `Plan`, journal evidence, raw replies or private errors are wire
fields. The exact current claim/policy/issuer/control pair must be independently
checked before effects and again after each relevant await. Stale/superseded
owners cannot stop, clear or adopt replacement work.

## Observations and source admission

The prepared observation contains the exact private `SourceBinding` with its
existing Go-struct JSON field order. `binding_sha256` hashes those bytes. All
binding strings are ASCII, so the declared TypeScript projection and Go
`json.Marshal` agree without a new canonicalization algorithm. The shared corpus
contains canonical bytes and their hash; neither is an attestation.

`request_id` and `checkpoint_repository` are wrapper fields obtained only from
the exact `SourceSpec` whose digest the coordinator's Binding method compared
with its durable reservation. They do not alter the private binding or its
hash. The complete sorted member vectors, immutable card branches, coordinator
format, observed source steps, exact run request and worker context are joined
rather than inferred from current repository tips or an unrelated current row.

An execute request carries the retained source admission receipt and exact
prepared binding digest. The real AdmissionGate must verify the receipt against
the authenticated service's stored **exact source**, fresh claim/epoch/policy,
reporter and control selection. Structural run/epoch/digest checks alone do not
prove that a receipt admits this source. The owner source-only service route is
itself proposed/default-off and must be available before wiring this crossing.

A completion wraps the observed source, final service observation, and strict
worker result. The private accessor must reparse actual durable replies and raw
worker bytes under its journal lock and compare the saved immutable proposal.
`worker_result_sha256` hashes those original raw bytes, not a newly serialized
worker object. The parser checks all publicly representable joins and complete
vectors. `stopped`/`released` booleans are observations, never byte-level proof
of a process fence, lease release, board settlement or accepted attestation.
Handoff is bounded **untrusted child text**, including any URLs; it is not
repository evidence or a claim that secrets cannot occur in child output.

## Limits, refusal and recovery

Request and response parsers enforce 64 KiB and 256 KiB of actual serialized
UTF-8 bytes respectively, including the entire vectors and worker result.
Worker result JSON is also bounded to 64 KiB. Strict lexical parsing refuses
malformed UTF-8, isolated surrogate escapes, duplicate decoded keys, nulls,
ambiguous numeric lexemes, unsafe integers, excess depth and trailing data.
Known inner fields are closed. Transport adapters must enforce frame bounds
before allocation and map filesystem/context/internal errors to the closed
refusal codes; they must never forward `err.Error()`, payloads or capabilities.

`unknown`, `pending` and `superseded` are cap-free states and confer no right to
redispatch or adopt another owner. Same-run status can return preserved exact
observations only after current or explicitly historical disclosure
authorization. Lost replies require reconciliation, not a fresh request ID or
rerun. Same-SHA completions remain structurally valid; administrator policy must
separately admit them. No operation-bound cross-RPC cancellation endpoint or
uncertain-growth repair is implemented by these DTOs. Until independently
verified cancellation, current/authenticated gates, transport, actual source
admission and immutable settlement are integrated, the DX pilot stays disabled.

## Conformance

`src/fixtures/bench-coordinator-v1.json` is shared directly by Bun and Go tests.
It covers ordinary refusals, prepared and completed grouped observations,
identity/vector/digest substitution, lexical ambiguity and private field
injection. Required checks are the actual contract CI tests and generated-Go
fixture check, plus the node-agent vet/race/build and quality ratchets for its
additive parser package. No existing accepted v1/v2 fixture bytes are changed.
