# Private dispatch ledger

This package is an unwired node-side foundation. It does not enable the pilot,
change node/hub frames, submit board mutations, certify shared policy, negotiate
an API, supply model credentials, or implement grouped execution. The accepted
scalar worker must run **inside `benchd.run`**. The package has no ACP fallback.

`Store.Prepare` records the exact owner, registered bench, authorized source
vector, policy/control pair, service request hashes, and private worker context
and executable identities. The caller must obtain those authorities first.
`Dispatch` validates the exact raw accepted scalar request and local artifacts,
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
it cannot rename the earlier run's proof. The grouped-v2 observation shape is
reserved proposed data, not an implemented or accepted consumer protocol.

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
