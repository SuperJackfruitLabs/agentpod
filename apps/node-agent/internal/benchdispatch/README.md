# Private dispatch ledger

This package is a private node-side coordinator and dispatch journal. It does not
enable the pilot,
change node/hub frames, submit board mutations, certify shared policy, negotiate
an API, or supply model credentials. The accepted
scalar worker must run **inside `benchd.run`**. The package has no ACP fallback.

`Store.Prepare` records the exact owner, registered bench, authorized source
vector, policy/control pair, service request hashes, and private worker context
and executable identities. The caller must obtain those authorities first.
`Dispatch` validates the exact raw accepted scalar request or an explicitly
bound proposed grouped request and local artifacts,
calls the mandatory admission `Gate`, and fsyncs the pending intent before its
one launch callback. The callback must submit that request to `benchd.run`.
Inspecting status or reconciling a service receipt never calls the callback.
A crash before the callback is conservatively pending even if no child started.
Uncertain, pending, or superseded attempts block a new owner; there is no implicit
adoption, timeout-based lease release, key-only administrative stop, or reset.

`StageProposal` requires independently verified trusted receipt/result bytes,
stopped execution, every published checkpoint and confirmed release. It stores
only their bounded hashes and credential-free vector, never the raw private
response, local execution log, or arbitrary worker links. A mandatory `Verify`
callback is a local trust seam, **not accepted external certification authority**.
The current owner/policy gate is rechecked after asynchronous verification.
Same-attempt replay returns identical persisted proposal bytes. A new run can
produce a new proposal at the same commit only after its own launch and evidence;
it cannot rename the earlier run's proof. The grouped-v2 observation shape
requires an explicit grouped plan; it remains proposed, not an accepted consumer
protocol.

A proposal is not board acceptance. Future hub wiring must independently check
its authenticated selected service reporter, current epoch/heartbeat/policy,
executor/node/station allowlist and nonweakenable pilot gate. A reporter service
JWT belongs on the hub and must never reach this package, worker context or node.
Only a private SuperBench continuation capability may enter `Capability`; it
refuses JSON/text serialization, redacts formatting, and is retained separately
in a private file for exact-owner reconciliation. It is not in ordinary ledger
or proposal JSON. Supersession never stops or clears a later owner.

One atomic per-bench document updates the active reservation and immutable record
together under an OS file lock. Files and parent directories are fsynced before
success. Private physical paths, bounded strict decoding and retained uncertain
state support crash safety. The retained histories have a hard bound; exhaustion
requires separately reviewed maintenance, not automatic deletion. The package
assumes trusted commands under the same UID: permissions, executable hashes and
file locks do not isolate a hostile command running as that UID. There is no
claim of a transaction with the external board or an atomic authorization check
across that network boundary. Full cancellation during configured setup, worker
release packaging, node/hub wire, settlement authority and the complete multi-repo
adapter remain separate owner-reviewed work.

An optional immutable `grouped` descriptor binds the registered 32-hex bench ID,
physical aggregate root, selected logical member and complete sorted member
vector including object formats. The actual v2 launch must reuse a private held
token, omit service `repository_name`, keep checkpoint/release enabled and invoke
exactly `[packaged worker, private context, expected context SHA256]`. The context
bytes, binding, root and complete vector must match that descriptor. Scalar plan
serialization omits it and retains its existing launch validation. These checks
bind a launch; the packaged worker checks actual checkouts after preparation
inside `benchd.run`. They are neither fencing proof nor host attestation.

`Store.Prepare` still requires a full vector and exact launch. The separate
`SourceCoordinator.Prepare` reserves a typed `SourceSpec` in the same per-bench
document before any acquisition. Its fixed task/run/epoch, host, repository/ref
allowlist, context location outside the data root, packaging hashes and task
input digest cannot change during preparation. The exact packaged grouped
worker board/card/run binding grammar is checked before reservation or any
service call; scalar-v1 identity behavior remains unchanged. The current trusted owner,
registry and control-pair callback is mandatory and rechecked after transport
awaits; metadata supplied by an untrusted caller is not that authorization.

The concrete coordinator optionally creates with initialization, then calls the
actual Unix client to lease (including configured preparation) and checkpoint
while retaining that exact token. It never prepares an unowned checkout. Exact
request bytes are privately fsynced and their one send opportunity consumed
before transport. Complete replies are privately captured before journal
advancement. An uncertain send, including a crash before transport starts, stays
reserved with no redispatch. A captured reply whose document advancement was
interrupted can be reparsed and reconciled without another service request.
Known partial failures also retain the reservation and private response.

The private document upgrades from v1 to v2 only when a source reservation is
introduced; historical scalar records/proposals retain their original meaning.
Existing scalar and grouped reservations mutually exclude source preparation.
Repository URLs, task arguments/prompt/environment and continuation capabilities
stay out of ordinary reservation JSON. Explicit private wire artifacts have
0600 permissions and a non-JSON framing header; they can contain capabilities
and must never be forwarded as ordinary output. Parsing or hashing their bytes
is an observation, not cryptographic attestation.

Binding rereads the actual lease/checkpoint responses, exact holder/token,
registered bench ID, canonical configured root, whole checkpoint vector and
object-format widths, then constructs and hashes the protected worker context.
The task digest is independently checked again at binding. A single document
commit swaps the reservation for that immutable complete launch. Changed or
missing receipts refuse first dispatch and lost-reply bound-plan lookup. An
exact active `BoundSource` lookup returns only the cap-free, not-yet-launched
plan; it does not reissue a grant. Historical request IDs cannot be reused for
another acquisition. No automatic adoption, cleanup, rewind or release occurs.

Source preparation intentionally stops before payload launch. A production path
still needs accepted grouped/cancellation contracts and capability discovery,
actual common control-pair enforcement and authenticated selected-node routing,
immutable work-owner source admission, an explicit structured harness adapter,
full service receipt/result verification and service-only settlement. The
required callbacks are private trust boundaries for that caller, not substitutes
for those implementations. No public route or node verb imports this path.
`SourceCoordinator.Binding` projects the exact preserved start checkpoint and
receipt/request/context/worker hashes without private paths or capabilities.
`ExecuteBound` requires a separate mandatory `AdmissionGate` for independently
authenticated current Hub admission of that exact binding. No production route
supplies that gate. The coordinator loads its original private held-token run,
consumes the dispatch intent, and calls the concrete Unix client once. A valid
captured reply can be reconciled; a missing reply never causes redispatch.

The final observation requires an independently parsed successful producer run
reply with stopped execution, known zero orchestration exit, whole checkpoint,
and no held lease or pending vector, plus the strictly bound worker result.
Worker task outcomes remain distinct from orchestration success. Current owner
checks run again after admission and transport awaits. Private immutable ledger
proposals still include the original private Plan paths: they are not the Hub
wire result or an accepted settlement. SourceBinding is the separate path-free
projection. `benchcoordinator.ReadCompletion` additionally reparses a completed
journal entry, its saved producer response and exact worker result under the
journal lock before returning typed source, service and task fields. It omits
the private Plan. Task handoff remains bounded untrusted child output; it is
not sanitized or evidence of source authority. This private accessor neither
launches nor grants, and its future authenticated caller must authorize
disclosure and admission separately. Exact historical proposal replay cannot launch another child or
renew ownership. Actual authenticated Hub current/admission wiring, source trust
acceptance, and end-to-end coordinator integration remain required before use.
