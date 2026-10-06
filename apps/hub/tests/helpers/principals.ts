/**
 * Principals for tests, at the run's fake organization plane (`helpers/fake-plane.ts`).
 *
 * The hub's own `principals`, `principal_identities` and `principal_grants` tables were dropped
 * (P3 plan, Task 17). Tests that used to insert into them make the same facts here instead:
 *
 * - `createPrincipal` keeps the shape tests used: an agent goes through the real
 *   `services/principals.createPrincipal` (the plane's `createAgent`); a human or a service is
 *   added to the fake plane directly, as the plane's own pages would. A principal created with
 *   `userId` IS that user: under the plane an account id is the principal id (contract §2), so
 *   the same id is returned.
 * - `linkMatrixId` is a Matrix identity linked at the plane — and, for a human, the
 *   `human_matrix_ids` row the hub keeps for inviting them.
 * - `forgetPrincipals` is the cleanup `DELETE FROM principals …` used to be.
 */
import { rawSql } from "../../src/db/drizzle";
import { createPrincipal as createAtPlane } from "../../src/services/principals";
import { fakePlane } from "./fake-plane";
import type { PrincipalKind } from "../../src/db/schema/organization";

export async function createPrincipal(input: {
  kind: PrincipalKind;
  handle: string;
  displayName?: string;
  userId?: string;
}): Promise<string> {
  // A fixed handle reused by a later run of the same file: the plane would refuse it, and the
  // old table was cleaned between runs.
  const stale = [...fakePlane.principals.values()]
    .filter((p) => p.kind === input.kind && p.handle === input.handle && p.id !== input.userId)
    .map((p) => p.id);
  await forgetPrincipals({ ids: stale });
  // An account linked to a principal IS that principal under the plane, whatever its kind (a
  // test may sign in "as an agent" to prove a route refuses one).
  if (input.kind === "agent" && !input.userId) {
    return createAtPlane({ kind: "agent", handle: input.handle, displayName: input.displayName });
  }
  const id = fakePlane.addHuman({ ...(input.userId ? { id: input.userId } : {}), handle: input.handle, displayName: input.displayName ?? null });
  fakePlane.principals.get(id)!.kind = input.kind;
  return id;
}

/** Link a Matrix id at the plane; a human's is also kept in `human_matrix_ids`. */
export async function linkMatrixId(principalId: string, mxid: string): Promise<void> {
  await fakePlane.linkIdentity(principalId, "matrix", mxid);
  if (fakePlane.principals.get(principalId)?.kind === "human") {
    await rawSql`DELETE FROM human_matrix_ids WHERE matrix_id = ${mxid}`;
    await rawSql`
      INSERT INTO human_matrix_ids (principal_id, matrix_id) VALUES (${principalId}, ${mxid})
      ON CONFLICT (principal_id) DO UPDATE SET matrix_id = EXCLUDED.matrix_id`;
  }
}

/** Remove principals from the fake plane (and any `human_matrix_ids` row they had). */
export async function forgetPrincipals(where: { ids?: string[]; handles?: string[]; handleLike?: string }): Promise<void> {
  const like = where.handleLike
    ? new RegExp(`^${where.handleLike.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`)
    : null;
  for (const p of [...fakePlane.principals.values()]) {
    if (where.ids?.includes(p.id) || where.handles?.includes(p.handle) || (like && like.test(p.handle))) {
      fakePlane.remove(p.id);
      await rawSql`DELETE FROM human_matrix_ids WHERE principal_id = ${p.id}`;
    }
  }
}

/** Suspension is the plane's (contract §3.5); these stand in for its pages. */
export async function suspendPrincipal(id: string): Promise<void> {
  await fakePlane.suspend(id);
}
export async function restorePrincipal(id: string): Promise<void> {
  await fakePlane.unsuspend(id);
}

/** Unlink a principal's Matrix id at the plane, and the hub's copy for a person. */
export async function unlinkMatrixId(principalId: string): Promise<void> {
  for (const [k, v] of fakePlane.identities) if (v === principalId && k.startsWith("matrix\u0000")) fakePlane.identities.delete(k);
  await rawSql`DELETE FROM human_matrix_ids WHERE principal_id = ${principalId}`;
}

/** No grant at all — what deleting a `principal_grants` row was. */
export function clearGrant(principalId: string): void {
  const p = fakePlane.principals.get(principalId);
  if (p) p.grant = null;
}
