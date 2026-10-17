import { and, eq, sql } from "drizzle-orm";

import type { db as Db } from "../../db/drizzle";
import { stationForgeApiGrants as g } from "../../db/schema/forge-api-grants";

/** A db or a transaction; both expose select(). */
type Executor = Pick<typeof Db, "select">;

/**
 * The generation for a new grant: max(existing)+1 over ALL rows, tombstones included, keyed on
 * (stationIdSnapshot, provider, instance) so it survives station deletion and re-grants. Starts at 1.
 * The caller inserts in the same transaction; the live unique index serialises racing grants.
 */
export async function nextGeneration(
  db: Executor,
  tenantId: string,
  stationIdSnapshot: string,
  provider: string,
  instance: string,
): Promise<number> {
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
