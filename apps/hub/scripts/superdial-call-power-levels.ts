/**
 * Let the members of every existing bridge agent room publish call membership (superdial).
 *
 * New bridge rooms get this when provisioning creates them (`provision.ts`). Rooms that already
 * exist need it once: `org.matrix.msc3401.call.member`, `org.matrix.msc4143.rtc.member` and
 * `org.matrix.msc4143.rtc.slot` at power level 0, everything else in `m.room.power_levels` left as
 * it is. Written as the room's agent (the identity the bridge speaks as, which created the room).
 *
 * A real operation on a live homeserver: idempotent, and a dry run by default.
 *
 *     bun run scripts/superdial-call-power-levels.ts          # says what it would do
 *     bun run scripts/superdial-call-power-levels.ts --apply  # does it
 *
 * Needs DATABASE_URL, MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN.
 */
import { and, eq, isNotNull } from "drizzle-orm";

import { closeDatabase, db } from "../src/db/drizzle";
import { matrixRooms } from "../src/db/schema/matrix";
import { stations } from "../src/db/schema/stations";
import { createPowerLevelEnsurer } from "../src/services/matrix-as/call-power-levels";

const HS = process.env.MATRIX_HOMESERVER_URL ?? "";
const TOKEN = process.env.MATRIX_AS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply");

if (!HS || !TOKEN) {
  console.error("MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN are required");
  process.exit(2);
}

const ensure = createPowerLevelEnsurer({ homeserverUrl: HS, asToken: TOKEN });

const rows = await db
  .select({ roomId: matrixRooms.roomId, stationKey: stations.stationKey, speaker: stations.bridgeMatrixId })
  .from(matrixRooms)
  .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
  .where(and(eq(stations.matrixIdentityMode, "bridge"), isNotNull(stations.bridgeMatrixId)));

console.log(`${APPLY ? "applying" : "dry run"}: ${rows.length} bridge room(s)\n`);

const tally = { unchanged: 0, updated: 0, "would-update": 0 };
const failed: string[] = [];
for (const row of rows) {
  try {
    const result = await ensure(row.speaker ?? "", row.roomId, { apply: APPLY });
    tally[result]++;
    if (result !== "unchanged") console.log(`  ${result === "updated" ? "ok   " : "would"} ${row.stationKey}`);
  } catch (err) {
    failed.push(`${row.stationKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(
  `\n${APPLY ? `${tally.updated} updated` : `${tally["would-update"]} to update`}, ` +
    `${tally.unchanged} already allowed, ${failed.length} failed`,
);
for (const f of failed) console.log(`  FAIL ${f}`);
await closeDatabase();
if (failed.length) process.exit(1);
