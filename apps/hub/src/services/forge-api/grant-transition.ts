/** The grant state graph and `transition`, the one UPDATE every lifecycle step goes through. */
import { and, eq, inArray } from "drizzle-orm";

import type { DbExecutor } from "../../db/drizzle";
import {
  stationForgeApiGrants as g,
  type ForgeGrantState,
  type ForgeTokenHandle,
} from "../../db/schema/forge-api-grants";
import { ForgeApiGrantError } from "./errors";
import type { Grant, GrantRef } from "./grant-types";

// ─── State graph ──────────────────────────────────────────────────────────────

const ALLOWED: Record<ForgeGrantState, readonly ForgeGrantState[]> = {
  authorised: ["provisioned", "failed", "revoking"],
  // provisioned → provisioned: storing the blob, re-minting, or a retry that did not land.
  provisioned: ["provisioned", "delivered", "failed", "revoking"],
  // Self-edges: a rotation in progress, a re-verify, a re-supplied credential.
  delivered: ["delivered", "verified", "failed", "revoking"],
  // verified → delivered: a supplied/app credential replaced, awaiting its own verify.
  verified: ["verified", "delivered", "failed", "revoking"],
  // failed → provisioned: a retry; failed → failed: a retry that failed again; failed → verified:
  // a re-verify of a credential the node holds; failed → delivered: a retry of a refused delivery
  // that the node now POSITIVELY acknowledges (sendDeliver is the only writer of `delivered`).
  failed: ["provisioned", "failed", "verified", "delivered", "revoking"],
  revoking: ["revoking", "revoked", "failed"],
  // A tombstone is final.
  revoked: [],
};

export interface TransitionPatch {
  now: Date;
  /** Always written: a successful step clears the previous reason. */
  stateReason?: string | null;
  tokenHandle?: ForgeTokenHandle | null;
  generation?: number;
  isolation?: "separate-user" | "same-user" | null;
  deliveredAt?: Date | null;
  verifiedAt?: Date | null;
  /** Written as a pair or cleared as a pair (the table CHECKs it); omitted = unchanged. */
  sealed?: { blob: string; expiresAt: Date } | null;
  policyPendingSince?: Date | null;
}

/**
 * Move a grant from one of `from` to `to` in ONE UPDATE. Refuses an edge the graph does not have
 * (`bad-transition`) and a row that is no longer in any of `from` (`state-conflict`), so two
 * racing steps cannot both win. Returns the updated row.
 */
export async function transition(
  tx: DbExecutor,
  ref: GrantRef,
  from: ForgeGrantState[],
  to: ForgeGrantState,
  patch: TransitionPatch,
): Promise<Grant> {
  for (const f of from) {
    if (!ALLOWED[f].includes(to)) {
      throw new ForgeApiGrantError("bad-transition", `forge grant: ${f} → ${to} is not a lifecycle step.`, ref.id);
    }
  }
  const set: Partial<typeof g.$inferInsert> = {
    state: to,
    stateReason: patch.stateReason ?? null,
    updatedAt: patch.now,
    // The CHECK pairs these; nothing leaves `revoked`, so this is the whole rule.
    revokedAt: to === "revoked" ? patch.now : null,
  };
  if (patch.tokenHandle !== undefined) set.tokenHandle = patch.tokenHandle;
  if (patch.generation !== undefined) set.generation = patch.generation;
  if (patch.isolation !== undefined) set.isolation = patch.isolation;
  if (patch.deliveredAt !== undefined) set.deliveredAt = patch.deliveredAt;
  if (patch.verifiedAt !== undefined) set.verifiedAt = patch.verifiedAt;
  if (patch.policyPendingSince !== undefined) set.policyPendingSince = patch.policyPendingSince;
  if (patch.sealed !== undefined) {
    set.sealedBlob = patch.sealed?.blob ?? null;
    set.sealedExpiresAt = patch.sealed?.expiresAt ?? null;
  }
  const [row] = await tx
    .update(g)
    .set(set)
    .where(and(eq(g.tenantId, ref.tenantId), eq(g.id, ref.id), inArray(g.state, from)))
    .returning();
  if (!row) {
    throw new ForgeApiGrantError(
      "state-conflict",
      `forge grant ${ref.id} is not in ${from.join("/")}; it changed underneath this step.`,
      ref.id,
    );
  }
  return row;
}
