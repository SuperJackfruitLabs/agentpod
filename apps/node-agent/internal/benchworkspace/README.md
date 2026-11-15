# Proposed grouped source client

This private candidate consumes the proposed SuperBench v2 wire contract. No
node dispatch, hub route, board, grant or fallback imports or enables it. The
accepted scalar client remains unchanged. Contract acceptance and capability
discovery must precede a production caller.

The package pins the request/response schemas and complete shared corpora. Wire
DTOs and lexical/semantic validators were adapted from the pinned producer wire
implementation into this module, without runtime imports of SuperBench or
TypeScript. This is wire conformance, not an independent implementation of
producer authority. It deliberately omits the producer's private Authority API.
Producer-only negative cases remain structurally acceptable to a client, which
cannot infer a fence, authorized acquisition or complete inventory from bytes.

The client uses an explicit absolute Unix socket, POST /v2/operations, bounded
headers/body and a positive timeout up to one hour. It does not follow redirects,
read ambient proxy settings, reuse connections, retry, select another protocol,
perform stop_admin or redispatch children. Errors omit response text, request
bodies and capabilities. Partial results and historical grants remain private
attempt evidence; they never renew a released or superseded lease. A failed
mutation stays reserved in its durable dispatch ledger even when a failure is
classified as a known refusal rather than uncertainty.

Held-token run/setup requests are representable, but this does not close the
whole cancellation path. Lease acquisition and create/recover may themselves
prepare before returning a grant. Safe cancellation before that first grant
still needs an operation-bound producer contract and implementation. A late
key-only administrative stop is not an acceptable substitute. No initial-setup
cancellation, full grouped worker, source evidence verification, remote seal or
live Developer Experience pilot is claimed by these client tests.

Verification includes all shared request/response wire and lexical cases,
explicit producer-only evidence boundaries, actual Unix-socket one-request
behavior, a lost service reply, no version fallback/redirect, growth byte bounds,
invalid media/fields and redacted error text. Further real producer/consumer
lifecycle drills and node/hub integration remain required.

Fresh acquisitions bind any returned lease to the requested holder even before
the caller has a lease token. Unix-socket regressions reject foreign grants in
successful and partial-failure lease/run/setup replies without exposing a result
or capability; the durable attempt remains uncertain and is never retried.

The separate private cancellation extension pins the proposed cancellation
schemas and corpora without widening the ordinary request schema. It targets the
original growth request ID and its typed producer digest, including pre-grant
acquisition. Five actual producer goldens cover normalization, nested recovery
field order, Unicode escaping and present-false versus omitted fields.
`Cancel` sends one Unix request and retains uncertainty for every failure;
it never substitutes a token/key stop, fallback or another execution. Replies
are cap-free producer observations. `cancel_requested` is intent only, and even
schema-valid `cancelled` bytes cannot independently certify a fence. No production
caller enables this extension before reviewed producer support and acceptance.

`DoWithEvidence` uses the same once-only transport and validators as `Do` while
retaining the exact attempted request and complete bounded response bytes for an
explicit private evidence sink. The evidence object refuses ordinary JSON/text
serialization and redacts formatting because those bytes may contain a private
continuation. Hashes and captured bytes are observations only; malformed replies
still fail validation and lost replies remain uncertain. Neither capture nor a
request digest proves the producer received or executed a request. No source
coordinator, receipt verifier, reporter credential or settlement is enabled.
