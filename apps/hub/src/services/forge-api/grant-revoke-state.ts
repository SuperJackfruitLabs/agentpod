/**
 * What a revocation has outstanding, as the reason records it, and the node wipe. Below both the
 * delivery steps (a same-user refusal and a late ack wipe too) and the revoke operations.
 */
import { VERB_PARAMS, VERB_RESULTS } from "@agentpod/contract";
import { and, eq } from "drizzle-orm";

import { stations } from "../../db/schema/stations";
import { isUnknownVerb, scrub, untrusted } from "./grant-common";
import type { BrokerReply, ForgeApiDeps, Grant } from "./grant-types";

export const PROVIDER_PENDING = "provider-pending";
export const PENDING_OPERATOR = "revocation-pending-operator";
export const WIPE_PENDING = "wipe-pending";
export const WIPE_SKIPPED = "wipe-skipped: station-gone";
/** Reason suffix: reconcile verifies this grant once on its next sweep (a lifecycle reason). */
export const VERIFY_PENDING = "verify-pending";
/**
 * A supplied/app grant still `authorised`: the operator never supplied a credential, so nothing
 * exists at the provider or on the node. Revoking it needs neither side nor a confirmation.
 */
export const NOTHING_SUPPLIED = "nothing-supplied";
export const REVOKED_NOTHING_SUPPLIED = "revoked; no credential was ever supplied";
const neverSupplied = (row: Grant) => row.state === "authorised" && row.mode !== "minted" && row.deliveredAt === null && !row.sealedBlob;
export const REVOKED_STATION_GONE = "revoked; node wipe skipped: station-gone (credential inert)";

/** What a grant entering `revoking` has outstanding, as the reason revokePass reads. */
export function initialRevokeReason(row: Grant): string {
  if (neverSupplied(row)) return NOTHING_SUPPLIED;
  return `${row.mode === "supplied" ? PENDING_OPERATOR : PROVIDER_PENDING}; ${WIPE_PENDING}`;
}

type WipeResult = { status: "done" } | { status: "skipped" } | { status: "pending"; why: string };

/** Ask the node to wipe its stk entry. */
export async function wipeOnNode(deps: ForgeApiDeps, row: Grant): Promise<WipeResult> {
  if (!row.stationId) return { status: "skipped" };
  const [st] = await deps.db
    .select()
    .from(stations)
    .where(and(eq(stations.tenantId, row.tenantId), eq(stations.id, row.stationId)));
  if (!st) return { status: "skipped" };
  // Version skew: a node that does not advertise forge.api gets no frame at all; the wipe stays
  // queued until it does (the provider side, done independently, has made the copy inert).
  if (!(st.capabilities ?? []).includes("forge.api")) return { status: "pending", why: "node-lacks-forge.api" };
  const params = VERB_PARAMS["forge.api.revoke"].safeParse({ stationId: st.id, grantId: row.id });
  if (!params.success) return { status: "pending", why: "invalid revoke frame" };
  let res: BrokerReply;
  try {
    res = await deps.broker.request(st.nodeId, "forge.api.revoke", params.data);
  } catch (err) {
    return { status: "pending", why: untrusted(scrub(err)) };
  }
  if (!res.ok) {
    const error = untrusted(res.error ?? "node error");
    return { status: "pending", why: isUnknownVerb(error) ? "node-too-old" : error };
  }
  // removed:false means there was nothing to remove: the entry is gone either way.
  if (!VERB_RESULTS["forge.api.revoke"].safeParse(res.data).success) return { status: "pending", why: "unreadable revoke reply" };
  return { status: "done" };
}
