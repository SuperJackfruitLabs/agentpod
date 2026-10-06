/**
 * A person's Matrix id, by principal — see `db/schema/human-matrix-ids.ts` for why the hub keeps
 * this answer itself.
 *
 * Read with the person's `prn_`, which is also their `AuthUser.id` and the `user_id` on every row
 * they own (contract §2), so a caller holding a station's `userId` asks with it directly. No plane
 * call: inviting an owner to their agent's room must not depend on the plane being up.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { humanMatrixIds } from "../db/schema/human-matrix-ids";

/** The Matrix id this person is known by, or null — an ordinary answer: nobody is invited. */
export async function matrixIdForHuman(principalId: string): Promise<string | null> {
  const [row] = await db
    .select({ matrixId: humanMatrixIds.matrixId })
    .from(humanMatrixIds)
    .where(eq(humanMatrixIds.principalId, principalId))
    .limit(1);
  return row?.matrixId ?? null;
}

/**
 * Record what the plane said: `matrixId` is this human's. Called only with an answer from the
 * plane's identity lookup, never with a guess. A person re-linked to a new Matrix id replaces the
 * old one, and one Matrix id names one person, so any other holder of it is cleared first.
 */
export async function rememberHumanMatrixId(principalId: string, matrixId: string): Promise<void> {
  // Every inbound message from a person comes through here; the write is for the rare change.
  if ((await matrixIdForHuman(principalId)) === matrixId) return;
  await db.transaction(async (tx) => {
    await tx.delete(humanMatrixIds).where(eq(humanMatrixIds.matrixId, matrixId));
    await tx
      .insert(humanMatrixIds)
      .values({ principalId, matrixId })
      .onConflictDoUpdate({ target: humanMatrixIds.principalId, set: { matrixId, updatedAt: new Date() } });
  });
}
