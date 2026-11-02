/**
 * Delivering a sealed credential: one validated `forge.api.deliver` frame, its reply classified,
 * and what each outcome writes (`sendDeliver`), with the same-user refusal and the late-ack wipe.
 */
import { VERB_PARAMS, VERB_RESULTS } from "@agentpod/contract";
import { and, eq } from "drizzle-orm";

import { stationForgeApiGrants as g, type ForgeGrantState } from "../../db/schema/forge-api-grants";
import { ForgeApiGrantError } from "./errors";
import {
  SAME_USER_ACK_REQUIRED,
  bareHandle,
  compensateRevoke,
  expectLoginFor,
  isWriteGrant,
  loadGrant,
  revokingError,
  scrub,
  serviceNameFor,
} from "./grant-common";
import { log } from "./grant-log";
import { FORGE_DELIVER_TIMEOUT_MS, NODE_PREPARING, NODE_REFUSALS, TRANSIENT, nodeCode } from "./grant-node";
import { WIPE_PENDING, wipeOnNode } from "./grant-revoke-state";
import { transition } from "./grant-transition";
import type { BrokerReply, ForgeApiDeps, Grant, StationRow } from "./grant-types";

/** Test seam: runs immediately before a deliver frame's last state check (proves the check). */
export const deliverFaults: { beforeSend?: (grantId: string) => Promise<void> } = {};

type DeliverOutcome =
  | { kind: "acked"; isolation: "separate-user" | "same-user" }
  /** The frame may never have reached the node: retry with the same blob. */
  | { kind: "transient"; reason: string }
  /** The node said no, or did not positively confirm: not delivered. */
  | { kind: "refused"; reason: string }
  /** The node answered, but unreadably: it may have stored the credential. */
  | { kind: "ambiguous"; reason: string }
  /** Revocation began (markGrantsRevoking does not take the claim): nothing was sent. */
  | { kind: "revoking" };

/**
 * Validate and send one `forge.api.deliver` frame and classify the reply. Writes nothing; callers
 * decide what each outcome means for their state. Reasons never carry the blob.
 */
export async function relayDeliver(deps: ForgeApiDeps, row: Grant, station: StationRow, sealed: string): Promise<DeliverOutcome> {
  const frame = VERB_PARAMS["forge.api.deliver"].safeParse({
    stationId: station.id,
    stationKey: station.stationKey,
    grantId: row.id,
    provider: row.provider,
    instance: row.instance,
    mode: row.mode,
    serviceName: serviceNameFor(row),
    repositories: row.repositories,
    preset: row.preset,
    rules: row.rules,
    allowGraphql: row.allowGraphql,
    sealed,
    expectLogin: expectLoginFor(deps, row),
  });
  if (!frame.success) {
    // Paths only, never values: a value could be the blob.
    const where = frame.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    return { kind: "refused", reason: `invalid deliver frame (${where}); nothing was sent` };
  }

  // Last check before the frame leaves: an occupancy change may have marked the grant `revoking`
  // since this step read it (it does not wait for the claim). Never hand a revoking grant's
  // credential to a node. The window left after this read is closed by `afterAck`.
  if (deliverFaults.beforeSend) await deliverFaults.beforeSend(row.id);
  const [now] = await deps.db
    .select({ state: g.state })
    .from(g)
    .where(and(eq(g.tenantId, row.tenantId), eq(g.id, row.id)));
  if (!now || now.state === "revoking" || now.state === "revoked") return { kind: "revoking" };

  let res: BrokerReply;
  try {
    res = await deps.broker.request(station.nodeId, "forge.api.deliver", frame.data, { timeoutMs: FORGE_DELIVER_TIMEOUT_MS });
  } catch (err) {
    return { kind: "transient", reason: `delivery not attempted: ${scrub(err, sealed)}` };
  }
  if (!res.ok) {
    const error = scrub(res.error ?? "node error", sealed);
    const code = nodeCode(error);
    if (code === NODE_PREPARING) return { kind: "transient", reason: "delivery deferred: the node is preparing its broker; will retry" };
    if (code && NODE_REFUSALS[code]) return { kind: "refused", reason: `node refused delivery: ${code}: ${NODE_REFUSALS[code]}` };
    return TRANSIENT.has(error)
      ? { kind: "transient", reason: `delivery failed: ${error}; will retry` }
      : { kind: "refused", reason: `node refused delivery: ${error}` };
  }
  const ack = VERB_RESULTS["forge.api.deliver"].safeParse(res.data);
  if (!ack.success) return { kind: "ambiguous", reason: "node acknowledged delivery with an unreadable reply" };
  if (ack.data.ok !== true || ack.data.stored !== true) {
    return {
      kind: "refused",
      reason: `node did not confirm the token was stored (ok=${ack.data.ok}, stored=${ack.data.stored})`,
    };
  }
  return { kind: "acked", isolation: ack.data.isolation };
}

/**
 * The node stored a write credential but reports `same-user` isolation, and nobody acknowledged
 * that: never `delivered`. Wipe it from the node (best effort), take a minted token back at the
 * provider (404 ok), drop the blob, and fail the grant with the acknowledgement reason. Reconcile
 * leaves it alone until an acknowledgement is recorded (policy with acknowledgeSameUser).
 */
async function refuseSameUser(deps: ForgeApiDeps, row: Grant, station: StationRow): Promise<Grant> {
  const wipe = await wipeOnNode(deps, row);
  if (row.mode === "minted" && row.tokenHandle) {
    await compensateRevoke(deps.providers(row.provider), row.account, bareHandle(row.tokenHandle), row.id);
  }
  log.warn("forge write grant refused: same-user isolation without acknowledgement", { grantId: row.id, stationId: station.id });
  return transition(deps.db, row, [row.state], "failed", {
    now: deps.now(),
    sealed: null,
    isolation: "same-user",
    stateReason:
      `${SAME_USER_ACK_REQUIRED}: the node reported same-user isolation; a write grant needs the operator's acknowledgement` +
      (wipe.status === "pending" ? `; ${WIPE_PENDING}: ${wipe.why}` : ""),
  }).catch((err) => afterAckConflict(deps, row, err));
}

/**
 * The node acked a credential, but the grant's own UPDATE failed: revocation began after the last
 * pre-send check. The node now holds a credential its grant is revoking, so a node wipe must be
 * outstanding even if one already ran before the frame landed. Re-queue it (revoking), or log
 * (revoked: the provider side is done, the credential is inert). Always throws `grant-revoking`.
 */
export async function afterAckConflict(deps: ForgeApiDeps, row: Grant, err: unknown): Promise<never> {
  const cur = await loadGrant(deps.db, row).catch(() => null);
  if (!cur || (cur.state !== "revoking" && cur.state !== "revoked")) throw err;
  if (cur.state === "revoking" && !(cur.stateReason ?? "").includes(WIPE_PENDING)) {
    await transition(deps.db, cur, ["revoking"], "revoking", {
      now: deps.now(),
      stateReason: [cur.stateReason, `${WIPE_PENDING}: delivered after revocation began`].filter(Boolean).join("; "),
    }).catch(() => undefined);
  }
  log.warn("forge grant credential delivered after revocation began; node wipe re-queued", { grantId: row.id, state: cur.state });
  throw new ForgeApiGrantError("grant-revoking", `forge grant ${row.id} was revoked while it was being delivered.`, row.id);
}

export async function sendDeliver(deps: ForgeApiDeps, row: Grant, station: StationRow, sealed: string): Promise<Grant> {
  const out = await relayDeliver(deps, row, station, sealed);
  if (out.kind === "revoking") throw revokingError(row);
  if (out.kind !== "acked") {
    // A failed or unreadable ack keeps the sealed blob by design: it is ciphertext only the node can
    // open, it expires after 24 h, and keeping it lets a retry re-send instead of re-minting.
    // From delivered/verified (a re-supplied credential) a transient failure keeps the state.
    // Outside a rotation an unreadable ack is never success: it fails like a refusal.
    const to: ForgeGrantState =
      out.kind === "refused" || out.kind === "ambiguous" ? "failed" : row.state === "delivered" || row.state === "verified" ? row.state : "provisioned";
    log.warn("forge grant not delivered", { grantId: row.id, stationId: station.id, state: to, reason: out.reason });
    // A frame that may have landed (ambiguous/transient) on a grant revoked meanwhile: re-queue the wipe.
    return transition(deps.db, row, [row.state], to, { now: deps.now(), stateReason: out.reason }).catch((err) =>
      afterAckConflict(deps, row, err),
    );
  }
  if (out.isolation === "same-user" && isWriteGrant(row) && !row.sameUserAckAt) {
    return refuseSameUser(deps, row, station);
  }
  const done = await transition(deps.db, row, [row.state], "delivered", {
    now: deps.now(),
    deliveredAt: deps.now(),
    // A newly stored credential is unverified, whatever the grant was before.
    verifiedAt: null,
    isolation: out.isolation,
    sealed: null,
    // The acked deliver frame carried the row's current policy.
    policyPendingSince: null,
  }).catch((err) => afterAckConflict(deps, row, err));
  log.info("forge grant delivered", { grantId: row.id, stationId: station.id, isolation: out.isolation });
  return done;
}
