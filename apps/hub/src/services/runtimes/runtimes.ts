/**
 * Fleet-era runtime provisioning service (P4 Task 8).
 *
 * Orchestrates the full lifecycle of a provisioned runtime:
 *   create → mint-token → provision-driver → persist externalId
 *   destroy → driver.destroy → mark destroyed
 *   start / stop → driver.start/stop (guard on capability)
 *
 * "start" is not one verb, though. On a substrate whose stop is terminal there
 * is no start to call, and the honest restart is a create against the anchor
 * that carries the workspace — so startRuntime branches on the driver's
 * declared `stopSemantics` and reprovisionRuntime handles that half.
 *
 * Status honesty: `online` means "a node for this runtime is connected", so it
 * is written only where a node is observed — enrolment (enrollment.ts) and, for
 * a resumed instance whose agent keeps its credential and never re-enrols, the
 * gateway calling completeRuntimeStartForNode() below (#281). Everything here
 * can say at most "the substrate accepted my request" — hence `provisioning` /
 * `starting`, and sweepStalledRuntimeStarts() to expire the ones that never
 * come back.
 *
 * `stopped` is the same rule at the other end: it means "the substrate says the
 * container is down", so it is written only on the substrate's own answer
 * (RuntimeProvisioner.status), never because stop() resolved. In between comes
 * `stopping`, reconciled by sweepStalledRuntimeStops().
 *
 * Error semantics for routes:
 *   - "provider disabled: X"     → 400 (user chose a disabled provider)
 *   - "provider not registered"  → 400 (same surface — misconfigured)
 *   - "unsupported operation"    → 400 (start/stop not supported by driver)
 *   - "not found"                → 404
 *   - driver provision() throw   → status set to "error"; rethrow (→ 502)
 *
 * This file is the service's surface: it re-exports what the module's index and the tests use,
 * from the files that hold each concern:
 *
 *   rows         the row, its contract shape, the workspace scope, ids, durations
 *   probe        asking a driver for container state; the confirmed stop
 *   create       createRuntime and its guards
 *   reads        listRuntimes, getRuntime, nodesWithFixedImage
 *   destroy      destroyRuntime
 *   reprovision  re-creating an instance against the same anchor
 *   start        startRuntime, completeRuntimeStartForNode, the stalled-start sweep
 *   stop         stopRuntime, the stalled-stop sweep
 *   rotation     the instance-lifetime rotation sweep
 *   unobserved   the sweep of runtimes whose node has been unseen (#347)
 */

/**
 * Image resolution lives in ./image.ts, so that boot-time config validation can ask the same
 * question without importing this module and, with it, the database layer. Re-exported because
 * every caller and both test files reach it through here.
 */
export { imageForHarness } from "./image";
// Re-export for convenience (routes use this)
export { enabledProviders, providerManifests } from "../provisioner";

export type { RuntimeRow, RuntimeScope } from "./rows";
export { createRuntime } from "./create";
export { getRuntime, listRuntimes, nodesWithFixedImage } from "./reads";
export { destroyRuntime } from "./destroy";
export { reprovisionRuntime } from "./reprovision";
export {
  START_TIMEOUT_MS,
  completeRuntimeStartForNode,
  startRuntime,
  sweepStalledRuntimeStarts,
} from "./start";
export { STOP_TIMEOUT_MS, stopRuntime, sweepStalledRuntimeStops } from "./stop";
export { ROTATION_MARGIN_MS, sweepExpiringRuntimes } from "./rotation";
export { UNOBSERVED_GRACE_MS, sweepUnobservedRuntimes } from "./unobserved";
