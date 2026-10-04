/**
 * What the `attempt` span needs from the attempt's row. ws3 records the fingerprint when the
 * attempt opens (C3). It is never recomputed here. A missing value is "unknown", never empty.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { acpRuns } from "../db/schema/acp";
import { stations } from "../db/schema/stations";

export async function attemptSpanFacts(attemptId: string): Promise<{ fingerprintDigest: string; harnessName: string }> {
  const [row] = await db
    .select({ digest: acpRuns.fingerprintDigest, harness: stations.harness })
    .from(acpRuns)
    .leftJoin(stations, eq(stations.id, acpRuns.stationId))
    .where(eq(acpRuns.id, attemptId))
    .limit(1);
  return { fingerprintDigest: row?.digest || "unknown", harnessName: row?.harness || "unknown" };
}
