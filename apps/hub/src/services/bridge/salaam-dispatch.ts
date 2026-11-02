/**
 * The strict Salaam dispatch path: a strict run is selected by a fresh runtime probe, driven by one
 * driver in this hub through Salaam's private work verbs, and recovered (resumed, parked or
 * settled) from its durable owner, never by a replacement claim.
 *
 * This file is the path's surface: it re-exports what the rest of the bridge (through `index.ts`)
 * and the tests use, from the files that hold each concern:
 *
 *   salaam-dispatch-plan      the runtime probe, the admitted plan, the re-run allowance
 *   salaam-dispatch-drivers   one driver per run in this hub process
 *   salaam-dispatch-proofs    a stopped owner, a settlement record and its verified receipt
 *   salaam-dispatch-release   a confirmed original release before execution ownership
 *   salaam-dispatch-settle    terminal settlement (never dispatched, known effects, expiry)
 *   salaam-dispatch-expired   an expired unanswered decision, recovered as a settlement
 *   salaam-dispatch-stopped   a stopped run settled when Salaam proves it, parked when not
 *   salaam-dispatch-drive     admission, the progression grant and the status loop
 *   salaam-dispatch-resume    recovering owned runs before any new claim
 *   salaam-dispatch-start     opening a claimed run
 *   salaam-dispatch-log       the strict-work log and its hops
 */

export type { StrictWorkSelection } from "./dispatch-types";
export { SALAAM_RERUN_ALLOWANCE, planFrom, probeSalaamWork } from "./salaam-dispatch-plan";
export { reconcileUnopenedSalaamRelease } from "./salaam-dispatch-release";
export { settleNeverDispatchedSalaamWork } from "./salaam-dispatch-settle";
export { recoverExpiredSalaamDecision } from "./salaam-dispatch-expired";
export { settleStoppedSalaamWork } from "./salaam-dispatch-stopped";
export { resumeSalaamWork } from "./salaam-dispatch-resume";
export { startSalaamWork } from "./salaam-dispatch-start";
