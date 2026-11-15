# Internal SuperBench adapter foundation

This package and `cmd/agentpod-bench-worker` are an unconnected scalar-v1
foundation with private protected grouped-worker groundwork, not an enabled adapter, consumer
acceptance claim or completed Developer Experience pilot. Existing ACP dispatch
and node contracts are unchanged.

Source base: AgentPod f2e95100ffe86924ceef4b059b1f6c0e8febb693;
accepted ownership: charter 175af4afe195e23320c7cced082dcf8f652c812b.
`request.go` and its canonical-vector tests were copied from SuperBench
615cd06b97187dbf9b74cdafcc898979ff116f8a `internal/protocol`, with package
rename/comment and an equivalent errors.Is EOF comparison required by consumer
lint (the provenance test reverses these documented adaptations). `testdata/producer.json` records its source hash and the owner
PR33 merge d77696442926b58b9b208257c222c0a30bd8ad71. That owner fix rejects null command arguments without
changing canonical accepted v1 schema/vector bytes.
`testdata/source.json` pins the exact treaty v1 schema/vectors
revision and SHA256s. This does not adopt SuperBench's database/internal layout.
The canonical bytes remain unchanged. The historical source manifest says
proposal; the current charter/local-api document records acceptance separately.

## Intended use

1. The authenticated parent checks explicit board/station opt-in, authorizes the
   repository, binds run/card/epoch, creates a private context parent (0700) outside
   checkout data, and prepares one WorkerSpec. No board credentials/MCP are
   included. A harness must support the specified bounded JSON stdin/stdout
   protocol; existing ACP harnesses do not automatically support it.
2. Warm-create with `initialize:true`, validate its success, then submit exactly
   one v1 `run` with the worker executable's absolute path and private context
   directory as its sole argument. Leave checkpoint omitted/true. `run` owns
   lease acquisition and atomic supervised launch. Do NOT launch this executable
   first and subsequently register a lease. The standalone executable is an
   internal trusted payload, not an authority checker or sandbox.
3. The actual harness runs under that worker with fresh HOME/XDG/TMP directories,
   explicit environment allowlist, no inherited service tokens or MCP proxy.
   Only PATH/LANG/LC_ALL/TZ/TERM are configurable. The entrypoint clears its own
   inherited environment. Model authentication is deliberately not implemented:
   a future reviewed credential input must not carry board mutation authority.
4. A complete harness result is evidence only. The parent validates the worker
   binding plus benchd's successful fence/checkpoint/release response (stopped
   execution, exit0, exact checkpoint, absent lease). Then persist an idempotent
   settlement receipt and attach references/settle the board using parent-held
   credentials. No board operations are implemented here.
5. A transport/protocol/receipt ambiguity NEVER resubmits Run or acquires another
   owner. Inspect status and original request receipt/state; reconcile retained
   ownership explicitly. Request IDs bind retries to the identical body. A
   historical receipt never restores ownership or proves current writer safety.
   Do never turn failure into permission to reset/delete a checkout or context.

Worker orchestration success is distinct from test success: Failing test may
produce a complete structured result documenting an expected test failure while
its orchestration exits0 and leaves committed clean work. A harness process
failure/nonzero orchestration preserves context and causes benchd to retain its
stopped lease. Board mutation waits for explicit reconciliation/checkpoint/release.

0700/0600 protect private storage from other users. They do not isolate a hostile
same-UID command. This is the accepted trusted-command local boundary; no UID,
mount, arbitrary remote endpoint or board token audience is introduced.

## Release artifact foundation

The product release build includes `agentpod-bench-worker-<os>-<arch>` for the
same Linux/macOS and amd64/arm64 matrix as node/fleet. `version` reports the
release tag, platform and private worker protocol. The existing release kit
includes these assets in SHA256SUMS and provenance. A future dispatcher must
select an explicit release tag, verify the worker checksum/provenance and bind
the exact executable digest in its private plan. This does not install the
worker, change self-update, or enable dispatch. No worker release is claimed here.

## Remaining integration

No board dispatch, station capability, gateway request, ACP override, board
credentials, control-pair authorization, attempt ledger, heartbeat, cancellation,
settlement replay or clean-checkout integration verification is wired here.
Those must be added in owner-first reviewed contracts/consumer tests. Multi-repo
requires the proposed v2 producer and shared request/response/lifecycle conformance,
one writer/all-member seal/release, exact recovered generations and independent
clean Integrate checkout. Do not fall back from v2 to this scalar foundation.

Client v1 tolerates unknown response fields as the accepted contract requires;
worker-local schemas are strict. Both reject duplicate keys/trailing documents
and use bounded reads. Failure.Error never prints raw service messages or tokens;
a typed retained response is private operator reconciliation data and must not
be logged. The client does not currently implement a durable adapter settlement
ledger or an adapter-local operation receipt journal.

## Private protected grouped worker candidate

The additive two-argument worker mode is private groundwork. It does not enable
node dispatch or adopt a shared worker wire contract. The original one-argument
scalar invocation, version output, context, client and result semantics stay v1.
A future authenticated grouped coordinator packages `GroupedWorkerSpec` outside
the checkout data, binds its returned exact-byte SHA256 to source admission, and
submits service argv `[verifiedWorkerPath, contextDirectory, expectedSHA256]`.
The service request omits `repository_name`, so its supervised payload starts in
the aggregate root; the worker derives its optional selected member cwd itself.

The hash is checked before decoding context or creating launch artifacts. The
context binds board/card/run/epoch, bench key/ID, physical aggregate root and the
complete sorted repository vector. After service preparation, the worker checks
all physical member/control/common paths, exact origin digests, task refs,
formats and HEADs, index flags and clean tracked/untracked status before starting
one harness. It refuses external Git config/includes/filters, alternates,
replacement refs, partial clones and submodules. Fixed Git runs without optional
index writes, ambient Git variables or lazy fetch. Protected mode requires Unix
filesystem semantics. A valid launch consumes its private context exactly once;
source refusal retains that evidence and never rebinds admission automatically.

These checks establish the behavior of this trusted packaged executable under
the existing same-UID trusted-command boundary. Context permissions and its hash
do not isolate a hostile concurrent same-UID process or provide cryptographic
attestation. The structured child result is task output, never proof of fencing,
checkpoint confirmation or release. Those remain independently validated service
outcomes tied to the exact request and source admission. Live source binding,
issuer provisioning, approved policy enablement, cancellation, board settlement
and the real managed grouped pilot remain separate integration requirements.
