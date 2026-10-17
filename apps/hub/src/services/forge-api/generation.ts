import type { ForgeApiProvider } from "@agentpod/contract";
import { and, eq, sql } from "drizzle-orm";

import type { db as Db } from "../../db/drizzle";
import { stationForgeApiGrants as g } from "../../db/schema/forge-api-grants";

/** A db or a transaction; both expose select(). */
type Executor = Pick<typeof Db, "select" | "execute">;

/**
 * The generation for a new grant: max(existing)+1 over ALL rows, tombstones included, keyed on
 * (stationIdSnapshot, provider, instance) so it survives station deletion and re-grants. Starts at 1.
 *
 * Call this INSIDE the same transaction as the insert (pass the tx): it takes a transaction-scoped
 * advisory lock on (tenant, station snapshot, provider, instance), so a racing grant waits until
 * this one commits and then reads the new max. The unique index on (snapshot, provider, instance,
 * generation) is the backstop: a loser that bypassed the lock gets a clean 23505, never a
 * duplicate generation.
 */
export async function nextGeneration(
  db: Executor,
  tenantId: string,
  stationIdSnapshot: string,
  provider: ForgeApiProvider,
  instance: string,
): Promise<number> {
  const key = [tenantId, stationIdSnapshot, provider, instance].join("\u001f");
  // Outside a transaction this lock releases immediately and protects nothing; see above.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  const [row] = await db
    .select({ max: sql<number | null>`max(${g.generation})` })
    .from(g)
    .where(
      and(
        eq(g.tenantId, tenantId),
        eq(g.stationIdSnapshot, stationIdSnapshot),
        eq(g.provider, provider),
        eq(g.instance, instance),
      ),
    );
  return (row?.max ?? 0) + 1;
}
