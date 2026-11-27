/**
 * Let the members of existing bridge agent rooms publish call membership (superdial).
 *
 * New bridge rooms get this when provisioning creates them (`provision.ts`). Rooms that already
 * exist need it once: `org.matrix.msc3401.call.member`, `org.matrix.msc4143.rtc.member` and
 * `org.matrix.msc4143.rtc.slot` at power level 0, everything else in `m.room.power_levels` left as
 * it is. Written as the room's agent (the identity the bridge speaks as, which created the room).
 *
 * A real operation on a live homeserver: idempotent, and a dry run by default.
 *
 *     bun run scripts/superdial-call-power-levels.ts                      # every bridge room, dry run
 *     bun run scripts/superdial-call-power-levels.ts --room '!a:hs' --room '!b:hs'   # only these
 *     bun run scripts/superdial-call-power-levels.ts --room '!a:hs' --apply          # does it
 *
 * `--room` is repeatable and limits the dry run and `--apply` alike to those rooms. A named room
 * that is not a bridge agent room is reported as failed and left alone. Any other argument is
 * refused, so a mistyped `--room` never widens a run to every room.
 *
 * Needs DATABASE_URL, MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN.
 */
import type { PowerLevelResult } from "../src/services/matrix-as/call-power-levels";

export interface CallPowerLevelOptions {
  apply: boolean;
  /** Only these room ids; empty is every bridge room. */
  rooms: string[];
}

export interface BridgeRoom {
  roomId: string;
  stationKey: string;
  speaker: string | null;
}

export function parseCallPowerLevelArgs(argv: readonly string[]): CallPowerLevelOptions {
  const options: CallPowerLevelOptions = { apply: false, rooms: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--room" || arg.startsWith("--room=")) {
      const value = arg === "--room" ? argv[++i] : arg.slice("--room=".length);
      if (!value || value.startsWith("--")) throw new Error("--room needs a room id");
      options.rooms.push(value);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function runCallPowerLevels(
  deps: {
    rows: readonly BridgeRoom[];
    ensure(speaker: string, roomId: string, opts: { apply?: boolean }): Promise<PowerLevelResult>;
    log(line: string): void;
  },
  options: CallPowerLevelOptions,
): Promise<{ failed: number }> {
  const { apply, rooms } = options;
  const limited = rooms.length > 0;
  const wanted = new Set(rooms);
  const selected = limited ? deps.rows.filter((row) => wanted.has(row.roomId)) : [...deps.rows];
  const failed: string[] = [];
  for (const roomId of wanted) {
    if (!deps.rows.some((row) => row.roomId === roomId)) failed.push(`${roomId}: not a bridge agent room`);
  }

  deps.log(
    `${apply ? "applying" : "dry run"}: ` +
      (limited
        ? `${selected.length} of ${deps.rows.length} bridge room(s), limited by --room\n`
        : `${selected.length} bridge room(s)\n`),
  );

  const tally = { unchanged: 0, updated: 0, "would-update": 0 };
  for (const row of selected) {
    try {
      const result = await deps.ensure(row.speaker ?? "", row.roomId, { apply });
      tally[result]++;
      if (result !== "unchanged") deps.log(`  ${result === "updated" ? "ok   " : "would"} ${row.stationKey} ${row.roomId}`);
    } catch (err) {
      failed.push(`${row.stationKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  deps.log(
    `\n${apply ? `${tally.updated} updated` : `${tally["would-update"]} to update`}, ` +
      `${tally.unchanged} already allowed, ${failed.length} failed`,
  );
  for (const f of failed) deps.log(`  FAIL ${f}`);
  return { failed: failed.length };
}

if (import.meta.main) {
  let options: CallPowerLevelOptions;
  try {
    options = parseCallPowerLevelArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const HS = process.env.MATRIX_HOMESERVER_URL ?? "";
  const TOKEN = process.env.MATRIX_AS_TOKEN ?? "";
  if (!HS || !TOKEN) {
    console.error("MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN are required");
    process.exit(2);
  }

  const { and, eq, isNotNull } = await import("drizzle-orm");
  const { closeDatabase, db } = await import("../src/db/drizzle");
  const { matrixRooms } = await import("../src/db/schema/matrix");
  const { stations } = await import("../src/db/schema/stations");
  const { createPowerLevelEnsurer } = await import("../src/services/matrix-as/call-power-levels");

  const rows = await db
    .select({ roomId: matrixRooms.roomId, stationKey: stations.stationKey, speaker: stations.bridgeMatrixId })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .where(and(eq(stations.matrixIdentityMode, "bridge"), isNotNull(stations.bridgeMatrixId)));

  const { failed } = await runCallPowerLevels(
    { rows, ensure: createPowerLevelEnsurer({ homeserverUrl: HS, asToken: TOKEN }), log: (line) => console.log(line) },
    options,
  );
  await closeDatabase();
  if (failed) process.exit(1);
}
