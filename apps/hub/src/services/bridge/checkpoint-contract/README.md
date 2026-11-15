# Proposed checkpoint claim discovery

This internal consumer foundation follows the proposed checkpoint coordinator
agreement and the producer's `superpipeline.checkpoint-claim.v1` extension.
It enables no pilot, advertises no node capability, and constructs no reporting
authority. The accepted host-local SuperBench contract remains separate.

The canonical policy schema is copied byte for byte from Treaty. Provenance pins
its hash and the reviewed SuperPipeline source. Canonical policy goldens were
produced once by that source's `checkpoint-json.ts`; shipped code and tests import
no producer TypeScript and add no shared runtime package dependency.

An ordinary claimant sends no protocol and refuses returned checkpoint markers,
including null or unknown versions. An explicitly opted-in client preserves a
strict pending DTO only when its run, epoch, board, card, delegate, stage and
canonical policy agree with the actual response. This is discovery, not source
admission. Its context read additionally requires the same currently working run,
card owner and current policy. Policy/DTO hashes confer no grant or fencing proof.

Production constructors supply no dedicated dispatch port and do not opt in.
The private selector accepts a trusted internal port only. It captures an immutable
registry/host/worker target, checks it again after claiming and after reading the
same current run/policy, and selects dedicated work before ordinary prior-output
replay or strict Salaam dispatch. It requests `checkpointOnly: true` so unavailable
ACP cannot strand an ordinary claim or block a standalone worker. Failed or
uncertain dedicated work remains parked; it never falls back, releases another
owner, or sends a generic completion. No board credential is passed to the port.

The port is deliberately unwired: a real implementation must verify packaged
worker/coordinator readiness under the authenticated node, local registry and
common control pair, then enforce current operation-bound admission at execution
and settlement. A registry hash, station health, the parser, or an injected test
callback supplies none of that authority. The Go coordinator's private proposal
bytes are not a public result DTO and cannot cross this seam. The service reporter
credential must stay in the hub.

Producer changes land first; consumer acceptance, hosted checks, the actual source
coordinator crossing, cancellation, immutable settlement and the opt-in pilot are
separate gates. Nothing here turns a pending claim into admitted execution or
permits a prior run's output to be relabelled for a replacement run.
