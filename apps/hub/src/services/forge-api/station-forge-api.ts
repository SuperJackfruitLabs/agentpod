/**
 * Forge API access lifecycle, minted mode: grant → mint → seal → deliver
 * (spec docs/superpowers/specs/2026-10-17-forge-api-access-design.md, "Lifecycle and failure handling").
 *
 * The rules this file exists to keep:
 *
 * - **The token lives in one local variable**, in `mintAndDeliver`, between `provider.mint` and
 *   `deps.seal`. It is never logged, stored, audited, put in a frame or in an error. Reasons and
 *   error messages are built from fixed text and ids; a provider/sealer/node error message is
 *   passed through `scrub` (which removes the token if it is known) before it is kept anywhere.
 * - **The station's public key is fetched before anything is minted**, so an unreachable station
 *   or an old node never leaves an orphan token at the provider.
 * - **The token handle is persisted (state `provisioned`) before sealing or delivery**, so a crash
 *   or a failed delivery leaves something reconcile can retry or revoke. A retry with a live sealed
 *   blob re-sends that blob; one without (expired after 24 h, or never stored) cannot re-seal — the
 *   hub has no plaintext — so it revokes the old token and mints generation + 1.
 * - **Every frame is validated with the contract schema before `broker.request`** (which does not
 *   validate), and **`delivered` needs a positive acknowledgement** (`ok === true && stored ===
 *   true`, parsed with the contract result schema). Silence, an empty reply or an unknown verb is
 *   never success.
 * - **Every state change is one UPDATE through `transition`**, which enforces the state graph and
 *   writes the fields the table's CHECKs pair (state/revoked_at, sealed_blob/sealed_expires_at).
 *
 * Every query is tenant-scoped.
 *
 * After delivery (verify, rotate, revoke, policy; the supplied and app modes), the rules are:
 *
 * - **Every mutating operation runs inside `withGrantClaim`**, so a rotate and a revoke on one
 *   grant cannot interleave: the second is `grant-busy`. Helpers below assume the claim is held.
 * - **Frames are validated before `broker.request` and replies parsed with VERB_RESULTS**; only a
 *   positive acknowledgement counts. Node offline/timeout is a typed outcome that changes nothing.
 * - **Node text is untrusted**: a reason or login from the node is stripped of control characters
 *   and capped at 200 characters before it is stored (`untrusted`).
 * - **A live `sealed_blob` on a delivered/verified grant means the node has NOT acknowledged the
 *   current credential** (an ambiguous rotation delivery, or a re-supplied credential whose relay
 *   failed transiently). `deliverGrant` re-sends it, and `verifyGrant` re-sends it before verifying:
 *   verifying without that could pass on the OLD credential (same account) and wrongly revoke it.
 * - **Rotation (minted)** — `token_handle.previous` (disposition `live-until-verified`) is persisted
 *   BEFORE the new token is minted. Then: mint → hub-side `checkToken` (identity of the new token)
 *   → seal → deliver → node verify.
 *   - PRE-ACK failure (mint, record, hub check, seal, a definitively refused deliver): the node is
 *     untouched, so the new token is revoked (404 ok; if that fails it is kept as `orphan`), the row
 *     goes back to the old handle and generation, reason `rotation-failed`, error `rotation-failed`.
 *   - AMBIGUOUS (deliver transient/timeout — the node may have stored it): nothing is revoked; the
 *     new token stays current with its sealed blob (24 h), state unchanged, reason
 *     `rotation-pending`. `deliverGrant`/`verifyGrant` finish it.
 *   - POST-ACK (the node stored it) and the verify is unreachable/inconclusive: nothing is
 *     revoked; state `delivered` (so `verifyGrant` can retry), blob cleared (acked), reason
 *     `rotation-pending`. A later matching `verifyGrant` revokes the old generation and clears
 *     `previous`.
 *   - POST-ACK and a definitive `wrong-identity`: the new token is revoked, the old one becomes
 *     `previous` with disposition `revoke` (nobody holds it), state `failed`, reason
 *     `rotation-failed`. The node holds a dead token either way; the grant needs a fresh mint.
 * - **Revocation**: one UPDATE to `revoking`, then the node wipe FIRST (best effort; it cuts the
 *   station's access at once), then the provider (minted: current, `previous`, `orphan`, 404 =
 *   success; app: nothing, installation tokens expire; supplied: agentpod cannot, so
 *   `revocation-pending-operator` until `confirmSuppliedRevoked`). `revoked` in one UPDATE once both
 *   sides are done. What is outstanding is recorded in the reason as `; `-joined parts, provider
 *   part first, and a retry does only those:
 *     `provider-pending: …`            the provider revoke failed; retry
 *     `revocation-pending-operator: …` supplied: the operator must revoke at the provider
 *     `wipe-pending: …`                the node wipe has not been confirmed; retry (Task 8 reconnect)
 *     `wipe-skipped: station-gone`     the station row is gone, so no node can be addressed
 *   With the station gone and the provider side done the grant is `revoked` with reason
 *   `revoked; node wipe skipped: station-gone (credential inert)`: a revoked-at-provider (or
 *   expiring) credential on an unaddressable node is inert. A revoke never mints and never needs
 *   the station key.
 * - **Policy** is not a transition: the row's policy is updated in one UPDATE that keeps the state.
 *   If the node cannot apply it the DB keeps the new policy (the next deliver frame carries it) and
 *   the outcome is `policy-pending`. The reason says `policy-pending` ONLY when it was empty or
 *   already a policy marker — a lifecycle reason (rotation-pending, wipe-pending, …) is never
 *   overwritten. Task 8's reconcile re-sends the policy on reconnect / compares `forge.api.status`.
 * - **The hub never opens a supplied/app blob**: it checks the envelope prefix and size and relays
 *   it byte-identical.
 *
 * This file is the lifecycle's surface: it re-exports what the module's index.ts, reconcile.ts and
 * the tests use, from the files that hold each concern. It has no code of its own.
 *
 *   grant-types          the dependencies, inputs and row types; the sealed-blob TTL
 *   grant-log            the one logger
 *   grant-transition     the state graph and `transition`
 *   grant-common         error scrubbing, tolerant revokes, row reads, the same-user rule
 *   grant-claim          the per-grant claim (slot cap + advisory lock)
 *   grant-node           `forge.api.status`, the verbs' timeouts, the node's coded refusals
 *   grant-revoke-state   revocation markers and the node wipe
 *   grant-deliver        one deliver frame and what its outcome writes
 *   grant-rotation-state a rotation on the row, its pre-ack undo, its blob's delivery
 *   grant-mint           deliverGrant, and mint → seal → deliver (`advance`)
 *   grant-create         createForgeApiGrant
 *   grant-verify-answer  `forge.api.verify` and its answer's classification
 *   grant-verify         what each answer does; verifyGrant
 *   grant-rotate         rotateGrant, undoExpiredRotation
 *   grant-revoke         revokeGrant, confirmSuppliedRevoked, markGrantsRevoking, stray handles
 *   grant-supplied       supplied and app credentials
 *   grant-policy         updateGrantPolicy
 */
export { ForgeApiGrantError } from "./errors";
export { CLAIM_CAP, POOL_RESERVE, claimFaults, withGrantClaim } from "./grant-claim";
export {
  SAME_USER_ACK_REQUIRED,
  blobIsLive,
  compensateRevoke,
  isWriteGrant,
  revokeTolerant,
  serviceNameFor,
  untrusted,
} from "./grant-common";
export { createForgeApiGrant } from "./grant-create";
export { deliverFaults } from "./grant-deliver";
export { deliverGrant } from "./grant-mint";
export {
  FORGE_DELIVER_TIMEOUT_MS,
  FORGE_STATUS_TIMEOUT_MS,
  FORGE_VERIFY_TIMEOUT_MS,
  fetchStationPublicKey,
} from "./grant-node";
export {
  confirmSuppliedRevoked,
  markGrantsRevoking,
  revokeGrant,
  revokeStrayHandles,
} from "./grant-revoke";
export type { RevokeCause, RevokeResult } from "./grant-revoke";
export { REVOKED_NOTHING_SUPPLIED, REVOKED_STATION_GONE, VERIFY_PENDING } from "./grant-revoke-state";
export { rotateGrant, undoExpiredRotation } from "./grant-rotate";
export { rotationOf } from "./grant-rotation-state";
export { SUPPLIED_BLOB_MAX, acceptSuppliedSecret, registerAppGrant } from "./grant-supplied";
export type { AcceptSuppliedInput } from "./grant-supplied";
export { updateGrantPolicy } from "./grant-policy";
export type { PolicyResult, UpdatePolicyInput } from "./grant-policy";
export { transition } from "./grant-transition";
export type { TransitionPatch } from "./grant-transition";
export { SEALED_BLOB_TTL_MS } from "./grant-types";
export type { CreateForgeApiGrantInput, ForgeApiDeps, Grant, GrantRef } from "./grant-types";
export { verifyGrant } from "./grant-verify";
export type { VerifyResult } from "./grant-verify";
