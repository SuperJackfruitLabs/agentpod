/**
 * Reading and writing the mapping between a principal here and the same
 * principal somewhere else.
 *
 * Phase 2 of docs/superpowers/plans/2026-08-15-organization-layer.md, and the
 * thing three other pieces of work are waiting on: an Application Service bridge
 * cannot attribute a Matrix message without it, approvals-from-chat cannot carry
 * their sender, and supermessage's decision row stays unreachable.
 *
 * **A record of sameness, never a grant.** Nothing here answers "may they", only
 * "are they the same". Reading authority out of this table is how the
 * Organization plane gets built by accident, in the wrong repository, without
 * the control pair that was supposed to come with it.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import {
  principalIdentities,
  IDENTITY_SYSTEMS,
  type IdentitySystem,
} from "../db/schema/identities";

export type { IdentitySystem };

function assertKnownSystem(system: IdentitySystem): void {
  // The CHECK constraint is the real guard; this exists so the failure names
  // the problem instead of surfacing as a Postgres constraint violation.
  if (!IDENTITY_SYSTEMS.includes(system)) {
    throw new Error(
      `unknown identity system "${system}" — expected one of ${IDENTITY_SYSTEMS.join(", ")}`
    );
  }
}

/**
 * Record that `principalId` is also known to `system` as `externalId`.
 *
 * Throws when the external identity already belongs to another principal, or
 * when this principal already has one for that system. Both are unique indexes
 * and both are load-bearing: an mxid that resolves to two people makes "who sent
 * this" unanswerable exactly when it matters most.
 */
export async function linkIdentity(
  principalId: string,
  system: IdentitySystem,
  externalId: string
): Promise<void> {
  assertKnownSystem(system);
  if (!externalId) {
    throw new Error("refusing to link an empty external id: that is a row that looks like a mapping");
  }

  await db.insert(principalIdentities).values({
    id: crypto.randomUUID(),
    principalId,
    system,
    externalId,
  });
}

/**
 * The principal an external identity belongs to, or null.
 *
 * Null is an ordinary answer, not a failure: most principals have no Matrix
 * account and never will, so a bridge asking about an unmapped one must degrade
 * rather than error.
 */
export async function principalByExternal(
  system: IdentitySystem,
  externalId: string
): Promise<string | null> {
  if (!externalId) return null;

  const rows = await db
    .select({ principalId: principalIdentities.principalId })
    .from(principalIdentities)
    .where(
      and(eq(principalIdentities.system, system), eq(principalIdentities.externalId, externalId))
    )
    .limit(1);

  return rows[0]?.principalId ?? null;
}

/** The id a principal is known by in one system, or null. */
export async function externalIdFor(
  principalId: string,
  system: IdentitySystem
): Promise<string | null> {
  const rows = await db
    .select({ externalId: principalIdentities.externalId })
    .from(principalIdentities)
    .where(
      and(
        eq(principalIdentities.principalId, principalId),
        eq(principalIdentities.system, system)
      )
    )
    .limit(1);

  return rows[0]?.externalId ?? null;
}

/** Every identity a principal has. */
export async function identitiesFor(
  principalId: string
): Promise<Array<{ system: string; externalId: string }>> {
  return db
    .select({
      system: principalIdentities.system,
      externalId: principalIdentities.externalId,
    })
    .from(principalIdentities)
    .where(eq(principalIdentities.principalId, principalId));
}

/** Remove one system's mapping. Idempotent — removing what is not there is not an error. */
export async function unlinkIdentity(
  principalId: string,
  system: IdentitySystem
): Promise<void> {
  await db
    .delete(principalIdentities)
    .where(
      and(
        eq(principalIdentities.principalId, principalId),
        eq(principalIdentities.system, system)
      )
    );
}
