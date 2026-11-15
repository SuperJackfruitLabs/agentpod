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

The existing bridge does not opt in. A later dedicated dispatch selector must
precede ordinary prior-output replay and strict Salaam dispatch, require actual
versioned worker/coordinator readiness under the current authenticated node and
control pair, bind the tenant/station/executor/policy, and refuse uncertainty
without falling back to ACP. Station health or a label cannot supply that
readiness. The service reporter credential must stay in the hub.

Producer changes land first; consumer acceptance, hosted checks, the actual source
coordinator crossing, cancellation, immutable settlement and the opt-in pilot are
separate gates. Nothing here turns a pending claim into admitted execution or
permits a prior run's output to be relabelled for a replacement run.
