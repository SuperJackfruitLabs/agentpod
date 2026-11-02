/**
 * Revocation: `revoking` in one UPDATE, the node wipe first, then the provider, `revoked` once
 * nothing is outstanding; the operator's confirmation for supplied tokens; an occupancy change's
 * mark (in the caller's transaction); and revoking a grant's superseded handles.
 */
import { and, eq, notInArray } from "drizzle-orm";

import type { DbExecutor } from "../../db/drizzle";
import {
  stationForgeApiGrants as g,
  type ForgeTokenHandle,
  type ForgeTokenRef,
} from "../../db/schema/forge-api-grants";
import { stations } from "../../db/schema/stations";
import { recordAudit } from "../audit";
import { ForgeApiGrantError } from "./errors";
import { withGrantClaim } from "./grant-claim";
import { bareHandle, loadGrant, revokeTolerant, scrub } from "./grant-common";
import { log } from "./grant-log";
import {
  NOTHING_SUPPLIED,
  PENDING_OPERATOR,
  PROVIDER_PENDING,
  REVOKED_NOTHING_SUPPLIED,
  REVOKED_STATION_GONE,
  WIPE_PENDING,
  WIPE_SKIPPED,
  initialRevokeReason,
  wipeOnNode,
} from "./grant-revoke-state";
import { transition } from "./grant-transition";
import { toRef, type ForgeApiDeps, type Grant, type Ref } from "./grant-types";

// ─── revoke ───────────────────────────────────────────────────────────────────

export interface RevokeResult {
  /**
   * revoked: both sides done. pending: the provider revoke failed, retry. pending-operator: a
   * supplied credential the operator must revoke. wipe-pending: provider done, node wipe queued.
   */
  outcome: "revoked" | "pending" | "pending-operator" | "wipe-pending";
  grant: Grant;
}

/**
 * One pass over a `revoking` grant (claim held): the outstanding sides only, wipe first, then the
 * provider; `revoked` when nothing is outstanding. `operatorConfirmed`: a supplied token the
 * operator says is revoked at the provider.
 */
async function revokePass(deps: ForgeApiDeps, row: Grant, operatorConfirmed: boolean): Promise<RevokeResult> {
  const reason = row.stateReason ?? "";
  if (reason.startsWith(NOTHING_SUPPLIED)) {
    const grant = await transition(deps.db, row, ["revoking"], "revoked", { now: deps.now(), stateReason: REVOKED_NOTHING_SUPPLIED });
    return { outcome: "revoked", grant };
  }
  const marked = [PROVIDER_PENDING, PENDING_OPERATOR, WIPE_PENDING, WIPE_SKIPPED].some((m) => reason.includes(m));
  // Unmarked (just entered, or moved to `revoking` by someone else): both sides are outstanding.
  const wipeNeeded = !marked || reason.includes(WIPE_PENDING);
  const providerNeeded = !marked || reason.includes(PROVIDER_PENDING) || reason.includes(PENDING_OPERATOR);
  let skipped = reason.includes(WIPE_SKIPPED);

  // 1. Node wipe first: it cuts the station's access at once, whatever the forge is doing.
  let wipePart: string | null = null;
  if (wipeNeeded) {
    const w = await wipeOnNode(deps, row);
    if (w.status === "skipped") skipped = true;
    if (w.status === "pending") wipePart = `${WIPE_PENDING}: ${w.why}`;
  }

  // 2. Provider.
  let providerPart: string | null = null;
  if (providerNeeded) {
    if (row.mode === "minted") {
      const provider = deps.providers(row.provider);
      const h = row.tokenHandle;
      const handles = [h, h?.previous, h?.orphan].filter((x): x is ForgeTokenRef => !!x).map(bareHandle);
      try {
        for (const x of handles) await revokeTolerant(provider, row.account, x);
      } catch (err) {
        providerPart = `${PROVIDER_PENDING}: ${scrub(err)}`;
        log.warn("forge grant revoke at the provider failed; will retry", { grantId: row.id, stationId: row.stationIdSnapshot });
      }
    } else if (row.mode === "supplied" && !operatorConfirmed) {
      providerPart = `${PENDING_OPERATOR}: the operator must revoke this token at the provider`;
    }
    // app: nothing to revoke — stk's installation tokens expire within about an hour. The operator
    // removes the App key on GitHub if the App itself should go.
  }

  // 3. Settle.
  if (!providerPart && !wipePart) {
    const grant = await transition(deps.db, row, ["revoking"], "revoked", {
      now: deps.now(),
      stateReason: skipped ? REVOKED_STATION_GONE : null,
    });
    log.info("forge grant revoked", { grantId: row.id, stationId: row.stationIdSnapshot, wipeSkipped: skipped });
    return { outcome: "revoked", grant };
  }
  const parts = [providerPart, wipePart, skipped ? WIPE_SKIPPED : null].filter((p): p is string => !!p);
  const grant = await transition(deps.db, row, ["revoking"], "revoking", { now: deps.now(), stateReason: parts.join("; ") });
  const outcome: RevokeResult["outcome"] = providerPart?.startsWith(PENDING_OPERATOR)
    ? "pending-operator"
    : providerPart
      ? "pending"
      : "wipe-pending";
  return { outcome, grant };
}

/**
 * Revoke a grant: `revoking`, node wipe first (best effort), then the provider, then `revoked`.
 * Re-entrant: calling it again on a `revoking` grant does only what its reason says is outstanding
 * (reconcile does this). Works with the station gone. Never mints, never needs the station key.
 */
export async function revokeGrant(deps: ForgeApiDeps, ref: Ref): Promise<RevokeResult> {
  const stale = await loadGrant(deps.db, toRef(ref));
  if (stale.state === "revoked") return { outcome: "revoked", grant: stale };
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    let row = await loadGrant(deps.db, stale);
    if (row.state === "revoked") return { outcome: "revoked", grant: row };
    if (row.state !== "revoking") {
      // One UPDATE; any undelivered blob goes with it. Both sides outstanding.
      row = await transition(deps.db, row, [row.state], "revoking", {
        now: deps.now(),
        stateReason: initialRevokeReason(row),
        sealed: null,
      });
    }
    return revokePass(deps, row, false);
  });
}

/**
 * The operator confirms a supplied token is revoked at the provider. Completes the revocation,
 * retrying an outstanding node wipe first (a gone station skips it).
 */
export async function confirmSuppliedRevoked(deps: ForgeApiDeps, ref: Ref): Promise<RevokeResult> {
  const stale = await loadGrant(deps.db, toRef(ref));
  if (stale.mode !== "supplied") {
    throw new ForgeApiGrantError("mode-not-supported", `forge grant ${stale.id} is ${stale.mode}; only supplied grants need an operator confirmation.`, stale.id);
  }
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    if (row.state === "revoked") return { outcome: "revoked", grant: row };
    if (row.state !== "revoking") {
      throw new ForgeApiGrantError("bad-transition", `forge grant ${row.id} is ${row.state}; revoke it first.`, row.id);
    }
    return revokePass(deps, row, true);
  });
}

// ─── occupancy changes and reconcile helpers (Task 8) ─────────────────────────

/** Why a station's grants are being revoked by an occupancy change or a deletion. */
export type RevokeCause = "reassigned" | "unassigned" | "station-deleted" | "node-removed";

/**
 * Move every live grant of a station to `revoking`, inside the CALLER'S transaction — the one that
 * changes the station's occupant or deletes it — so the two commit or roll back together.
 *
 * It never calls the forge or the node: an occupancy change must not wait on either, and must not
 * fail because of either. The provider revoke and the node wipe are the reconcile sweep's (and an
 * out-of-band kick's) job; the reason written here is exactly what `revokeGrant` treats as "both
 * sides outstanding", plus the cause. Any undelivered sealed blob goes with it. One audit row per
 * grant (ids and enums only). Returns the ids moved.
 */
export async function markGrantsRevoking(
  tx: DbExecutor,
  input: { tenantId: string; stationId: string; cause: RevokeCause; actor?: string; now?: Date },
): Promise<string[]> {
  const now = input.now ?? new Date();
  // FOR UPDATE: a concurrent lifecycle step waits for this transaction, then finds `revoking`.
  const live = await tx
    .select()
    .from(g)
    .where(
      and(
        eq(g.tenantId, input.tenantId),
        eq(g.stationIdSnapshot, input.stationId),
        notInArray(g.state, ["revoking", "revoked"]),
      ),
    )
    .for("update");
  if (live.length === 0) return [];
  const [st] = await tx
    .select({ nodeId: stations.nodeId, stationKey: stations.stationKey })
    .from(stations)
    .where(and(eq(stations.tenantId, input.tenantId), eq(stations.id, input.stationId)));
  const ids: string[] = [];
  for (const row of live) {
    await transition(tx, row, [row.state], "revoking", {
      now,
      stateReason: `${initialRevokeReason(row)}; cause: ${input.cause}`,
      sealed: null,
    });
    // Through the transaction: the audit row rolls back with the change it records.
    const audit = await recordAudit(tx, {
      tenantId: input.tenantId,
      userId: input.actor ?? "system",
      nodeId: st?.nodeId ?? "",
      stationKey: st?.stationKey ?? row.stationIdSnapshot,
      verb: "forge.api.revoking",
      params: {
        grantId: row.id,
        provider: row.provider,
        mode: row.mode,
        generation: row.generation,
        action: `revoking:${input.cause}`,
        ...(input.actor ? { actor: input.actor } : {}),
      },
    });
    await audit.done("ok");
    ids.push(row.id);
  }
  log.info("forge grants marked revoking", { stationId: input.stationId, cause: input.cause, grants: ids.length });
  return ids;
}

/**
 * Revoke a grant's superseded `previous` (disposition `revoke`) and its `orphan` handle at the
 * provider (404 = gone = success) and clear them from `token_handle`. Leaves a rotation in progress
 * (`live-until-verified`) alone, and revoking/revoked grants to `revokeGrant`. A
 * `previous-revoke-pending` reason is cleared once nothing is outstanding; any other reason stays.
 * Throws `revoke-failed` (after recording what did succeed) if a handle could not be revoked.
 */
export async function revokeStrayHandles(deps: ForgeApiDeps, ref: Ref): Promise<{ revoked: string[]; grant: Grant }> {
  const stale = await loadGrant(deps.db, toRef(ref));
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    const h = row.tokenHandle;
    const prev = h?.previous?.disposition === "revoke" ? h.previous : undefined;
    const orphan = h?.orphan;
    // Only states with a self-edge; revoking/revoked grants are revokeGrant's (it revokes these too).
    const selfEdge = row.state === "provisioned" || row.state === "delivered" || row.state === "verified" || row.state === "failed";
    if (!h || (!prev && !orphan) || !selfEdge) return { revoked: [], grant: row };
    const provider = deps.providers(row.provider);
    const next: ForgeTokenHandle = { ...h };
    const revoked: string[] = [];
    let failure: string | null = null;
    for (const [key, handle] of [["previous", prev], ["orphan", orphan]] as const) {
      if (!handle) continue;
      try {
        await revokeTolerant(provider, row.account, bareHandle(handle));
        delete next[key];
        revoked.push(handle.name);
      } catch (err) {
        failure = scrub(err);
      }
    }
    const pendingReason = row.stateReason?.startsWith("previous-revoke-pending");
    const grant = await transition(deps.db, row, [row.state], row.state, {
      now: deps.now(),
      tokenHandle: next,
      stateReason: pendingReason ? (failure ? `previous-revoke-pending: ${failure}` : null) : row.stateReason,
    });
    if (failure) throw new ForgeApiGrantError("revoke-failed", `forge grant ${row.id}: a superseded token could not be revoked: ${failure}`, row.id);
    log.info("forge grant superseded tokens revoked", { grantId: row.id, count: revoked.length });
    return { revoked, grant };
  });
}
