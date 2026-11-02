/**
 * Supplied and app credentials: the operator seals the credential client-side; the hub checks the
 * envelope and relays it byte-identical. Never opened here.
 */
import { FORGE_API_SEALED_MAX, STK_HANDOVER_PREFIX } from "@agentpod/contract";

import type { ForgeGrantState } from "../../db/schema/forge-api-grants";
import { ForgeApiGrantError } from "./errors";
import { withGrantClaim } from "./grant-claim";
import { loadGrant, loadStation } from "./grant-common";
import { createForgeApiGrant } from "./grant-create";
import { sendDeliver } from "./grant-deliver";
import { transition } from "./grant-transition";
import { SEALED_BLOB_TTL_MS, toRef, type CreateForgeApiGrantInput, type ForgeApiDeps, type Grant, type Ref } from "./grant-types";

/** Supplied/app sealed credentials are small: a PAT or an App key. Measured in characters. */
export const SUPPLIED_BLOB_MAX = FORGE_API_SEALED_MAX;

// ─── supplied and app credentials ─────────────────────────────────────────────

export interface AcceptSuppliedInput extends Ref {
  /** The credential, sealed client-side by the operator to the station's stk key. Never opened here. */
  sealed: string;
}

/**
 * Relay an operator-sealed credential (supplied token or App key) to the node. The hub checks the
 * envelope prefix and size only, stores the blob for 24 h until acknowledged (like a minted
 * delivery), and sends it byte-identical. Also the rotation path for supplied/app grants.
 */
export async function acceptSuppliedSecret(deps: ForgeApiDeps, input: AcceptSuppliedInput): Promise<Grant> {
  const sealed = input.sealed;
  if (
    typeof sealed !== "string" ||
    !sealed.startsWith(STK_HANDOVER_PREFIX) ||
    sealed.length <= STK_HANDOVER_PREFIX.length ||
    sealed.length > SUPPLIED_BLOB_MAX
  ) {
    // Never echo the value: it may be a plaintext token pasted by mistake.
    throw new ForgeApiGrantError(
      "bad-sealed-blob",
      `forge: a supplied credential must be a ${STK_HANDOVER_PREFIX} envelope of at most ${SUPPLIED_BLOB_MAX} characters.`,
      input.grantId,
    );
  }
  const stale = await loadGrant(deps.db, toRef(input));
  if (stale.mode === "minted") {
    throw new ForgeApiGrantError("mode-not-supported", `forge grant ${stale.id} is minted; the hub makes its token.`, stale.id);
  }
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    if (row.state === "revoking" || row.state === "revoked") {
      throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
    }
    if (!row.stationId) {
      throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id}'s station is gone.`, row.id);
    }
    const station = await loadStation(deps.db, row.tenantId, row.stationId);
    const now = deps.now();
    // authorised/failed/provisioned → provisioned; delivered/verified keep their state until acked.
    const to: ForgeGrantState = row.state === "delivered" || row.state === "verified" ? row.state : "provisioned";
    const stored = await transition(deps.db, row, [row.state], to, {
      now,
      sealed: { blob: sealed, expiresAt: new Date(now.getTime() + SEALED_BLOB_TTL_MS) },
    });
    return sendDeliver(deps, stored, station, sealed);
  });
}

/** App mode in one call: create the grant (App slug as `expectedLogin`) and relay the sealed App key. */
export async function registerAppGrant(deps: ForgeApiDeps, input: CreateForgeApiGrantInput & { sealed: string }): Promise<Grant> {
  if (input.mode !== "app") {
    throw new ForgeApiGrantError("mode-not-supported", `forge: registerAppGrant is for app grants, not ${input.mode}.`);
  }
  const { sealed, ...grantInput } = input;
  const grant = await createForgeApiGrant(deps, grantInput);
  return acceptSuppliedSecret(deps, { tenantId: grant.tenantId, grantId: grant.id, sealed });
}
