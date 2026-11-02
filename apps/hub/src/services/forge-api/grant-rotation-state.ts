/**
 * A rotation's state on the row, its pre-ack undo, and sending its persisted blob. Shared by
 * delivery (a live rotation blob is re-sent), verify, and the rotate operation itself.
 */
import type { ForgeTokenRef } from "../../db/schema/forge-api-grants";
import { bareHandle, compensateRevoke, revokingError } from "./grant-common";
import { afterAckConflict, relayDeliver } from "./grant-deliver";
import { log } from "./grant-log";
import { transition } from "./grant-transition";
import type { ForgeApiDeps, Grant, StationRow } from "./grant-types";

/** Is this row mid-rotation, and has the node acknowledged the NEW token? */
export function rotationOf(row: Grant): { rotating: boolean; acked: boolean } {
  const rotating = row.tokenHandle?.previous?.disposition === "live-until-verified";
  // A rotation clears delivered_at when it starts and sets it only on a positive ack; the blob is
  // persisted before the frame goes out and cleared only on that ack. Both must say "acked".
  return { rotating, acked: rotating && row.deliveredAt !== null && !row.sealedBlob };
}

/**
 * PRE-ACK undo (claim held): the node never stored the new token, so it is revoked (404 ok; kept
 * as `orphan` if that fails) and the row returns to `previous` — its handle, generation and
 * delivered_at — with the blob cleared and reason `rotation-failed`. The node still holds n.
 */
export async function restorePrevious(
  deps: ForgeApiDeps,
  row: Grant,
  why: string,
  current?: ForgeTokenRef,
  secret?: string,
): Promise<Grant> {
  const prev = row.tokenHandle!.previous!;
  const cur = current ?? bareHandle(row.tokenHandle!);
  const gone = await compensateRevoke(deps.providers(row.provider), row.account, cur, row.id, secret);
  const reason = `rotation-failed: ${why}`;
  const restored = await transition(deps.db, row, [row.state], row.state, {
    now: deps.now(),
    generation: prev.generation ?? row.generation,
    tokenHandle: gone ? bareHandle(prev) : { ...bareHandle(prev), orphan: cur },
    deliveredAt: prev.deliveredAt ? new Date(prev.deliveredAt) : null,
    sealed: null,
    stateReason: reason,
  });
  log.warn("forge grant rotation undone before delivery; the previous token stays live", { grantId: row.id, reason });
  return restored;
}

/**
 * Send a rotation's persisted blob (claim held). Ack → `delivered` (blob cleared, delivered_at
 * set, unverified). Transient or an unreadable ack → ambiguous: unchanged, blob kept,
 * `rotation-pending`. A definite refusal → `restorePrevious` (reason `rotation-failed`).
 */
export async function sendRotationBlob(deps: ForgeApiDeps, row: Grant, station: StationRow): Promise<Grant> {
  const out = await relayDeliver(deps, row, station, row.sealedBlob!);
  // Revoking: the revoke takes both generations back (current and previous); nothing to undo.
  if (out.kind === "revoking") throw revokingError(row);
  if (out.kind === "refused") return restorePrevious(deps, row, out.reason);
  if (out.kind !== "acked") {
    log.warn("forge grant rotation delivery unconfirmed; nothing revoked", { grantId: row.id, stationId: station.id });
    return transition(deps.db, row, [row.state], row.state, { now: deps.now(), stateReason: `rotation-pending: ${out.reason}` }).catch(
      (err) => afterAckConflict(deps, row, err),
    );
  }
  const now = deps.now();
  return transition(deps.db, row, [row.state], "delivered", {
    now,
    deliveredAt: now,
    verifiedAt: null,
    isolation: out.isolation,
    sealed: null,
    stateReason: "rotation-pending: awaiting verification",
  }).catch((err) => afterAckConflict(deps, row, err));
}
