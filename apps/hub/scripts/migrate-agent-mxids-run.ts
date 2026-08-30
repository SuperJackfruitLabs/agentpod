/**
 * The caller `migrateAgentMxids` never had.
 *
 * Task 9 built the pure function and its ordering; nothing implemented
 * `rooms()`, `join()`, `leave()` or `setDirect()`, so the migration could not
 * be run at all. This wires live dependencies for the 32 rooms this fleet
 * actually has — and, on top of that, is the only place that decides which
 * rooms still need it.
 *
 * **Dry run is the default.** `bun run scripts/migrate-agent-mxids-run.ts`
 * prints exactly what would happen and changes nothing; only `--apply` does
 * anything to a homeserver. The report is what an operator reads before
 * deciding, so it names every room, both addresses, and which of the three
 * steps are still outstanding.
 *
 * ## Detecting a half-migrated room
 *
 * A run across 32 rooms is expected to die partway through, and the question
 * "does this room still need anything" cannot be answered from a database
 * flag — nothing writes `matrix_rooms.principal_id` today, so a flag-based
 * check would silently skip a room that is only half done. It is answered
 * from live membership instead, with `client.isJoined`.
 *
 * `migrateAgentMxids`'s own steps run in a fixed order — join, then
 * `setDirect`, then leave — so a room whose OLD user has already left proves,
 * by that ordering alone, that `setDirect` already succeeded on some earlier
 * pass: leave is unreachable otherwise. So this only has to ask two
 * questions, not three: is the new user joined, and has the old user left.
 * Both true together is the only state this omits from its report.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../src/db/drizzle";
import { stations } from "../src/db/schema/stations";
import { nodes } from "../src/db/schema/nodes";
import { matrixRooms } from "../src/db/schema/matrix";
import { principalIdentities } from "../src/db/schema/identities";
import { principalHandle } from "../src/services/principals";
import { bridgeUserId, localpartFor } from "../src/services/matrix-as/names";
import { createMatrixClient } from "../src/services/matrix-as/client";
import { matrixBridgeConfig } from "../src/services/matrix-as/index";
import { migrateAgentMxids, type MxidMigrationDeps } from "./migrate-agent-mxids";
import { createLogger } from "../src/utils/logger";

const log = createLogger("migrate-agent-mxids-run");

/** One room, as read off `matrix_rooms` joined through its station and node. */
export interface StationRoomRow {
  roomId: string;
  stationId: string;
  stationKey: string;
  nodeName: string;
  /** Null when the station has no occupying agent — see requirement 4. */
  principalId: string | null;
  /** The Better Auth id of the human this room belongs to. */
  ownerUserId: string;
}

/** One room's migration status, as reported to an operator and to the migration itself. */
export interface RoomStatus {
  roomId: string;
  stationKey: string;
  nodeName: string;
  handle: string;
  oldUserId: string;
  newUserId: string;
  /** Null when the owner has no Matrix identity mapped — `m.direct` cannot be fixed then. */
  ownerMxid: string | null;
  joinOutstanding: boolean;
  leaveOutstanding: boolean;
  /** See the file doc: coupled to the other two by `migrateAgentMxids`'s own step order. */
  directOutstanding: boolean;
}

export interface DescribeDeps {
  domain: string;
  rows(): Promise<StationRoomRow[]>;
  isJoined(userId: string, roomId: string): Promise<boolean>;
  principalHandle(id: string): Promise<string | null>;
  ownerMxidFor(userId: string): Promise<string | null>;
}

/**
 * Every room that still needs some of this migration, and nothing else.
 *
 * A room whose new user has joined and whose old user has left is left out
 * entirely — not because a flag says it is done, but because those two live
 * facts, together, are the only way this migration itself is capable of
 * reaching that state (see the file doc).
 */
export async function describeRooms(deps: DescribeDeps): Promise<RoomStatus[]> {
  const out: RoomStatus[] = [];

  for (const row of await deps.rows()) {
    if (!row.principalId) {
      log.warn(
        "station has no occupying agent, so its room has no address to migrate to — omitted",
        { stationId: row.stationId, stationKey: row.stationKey, nodeName: row.nodeName }
      );
      continue;
    }

    const handle = await deps.principalHandle(row.principalId);
    if (!handle) {
      log.warn(
        "principal has no handle, so its room has no address to migrate to — omitted",
        { stationId: row.stationId, principalId: row.principalId }
      );
      continue;
    }

    // Derived, not read back from anywhere: the old address is what
    // `provision.ts` minted from the station's own (node, key) pair, and
    // nothing today stores it. See requirement 3.
    const oldUserId = `@agent_${localpartFor(row.nodeName, row.stationKey)}:${deps.domain}`;
    const newUserId = bridgeUserId(handle, deps.domain);

    const newJoined = await deps.isJoined(newUserId, row.roomId);
    const oldStillJoined = await deps.isJoined(oldUserId, row.roomId);

    const joinOutstanding = !newJoined;
    const leaveOutstanding = oldStillJoined;
    const directOutstanding = joinOutstanding || leaveOutstanding;

    if (!joinOutstanding && !leaveOutstanding) continue; // every step is already done

    out.push({
      roomId: row.roomId,
      stationKey: row.stationKey,
      nodeName: row.nodeName,
      handle,
      oldUserId,
      newUserId,
      ownerMxid: await deps.ownerMxidFor(row.ownerUserId),
      joinOutstanding,
      leaveOutstanding,
      directOutstanding,
    });
  }

  return out;
}

/** What `buildMigrationDeps` needs from a live (or fake) Matrix client. */
export interface DirectClient {
  join(userId: string, roomId: string): Promise<void>;
  leave(userId: string, roomId: string): Promise<void>;
  getAccountData(userId: string, type: string): Promise<Record<string, unknown> | null>;
  setAccountData(userId: string, type: string, content: Record<string, unknown>): Promise<void>;
}

/**
 * Wire `RoomStatus[]` into the deps shape `migrateAgentMxids` consumes.
 *
 * `setDirect` is where the read-modify-write lives: `m.direct` is every DM
 * the owner has, not just this one, so this reads the map, changes only the
 * two keys this room touches, and writes the whole thing back. A room whose
 * owner has no linked Matrix identity is logged and left alone rather than
 * guessed at.
 */
export function buildMigrationDeps(rooms: RoomStatus[], client: DirectClient): MxidMigrationDeps {
  const byRoom = new Map(rooms.map((r) => [r.roomId, r]));

  return {
    rooms: async () => rooms.map((r) => ({ roomId: r.roomId, handle: r.handle, oldUserId: r.oldUserId })),
    join: (userId, roomId) => client.join(userId, roomId),
    leave: (userId, roomId) => client.leave(userId, roomId),
    async setDirect(newUserId, roomId) {
      const room = byRoom.get(roomId);
      if (!room?.ownerMxid) {
        log.warn("cannot fix m.direct: the room's owner has no linked Matrix identity", {
          roomId,
        });
        return;
      }

      const current = (await client.getAccountData(room.ownerMxid, "m.direct")) ?? {};
      const next: Record<string, unknown> = { ...current };

      const oldRooms = Array.isArray(next[room.oldUserId]) ? (next[room.oldUserId] as unknown[]) : [];
      const remaining = oldRooms.filter((r) => r !== roomId);
      if (remaining.length > 0) next[room.oldUserId] = remaining;
      else delete next[room.oldUserId];

      const newRooms = Array.isArray(next[newUserId]) ? (next[newUserId] as unknown[]) : [];
      if (!newRooms.includes(roomId)) next[newUserId] = [...newRooms, roomId];

      await client.setAccountData(room.ownerMxid, "m.direct", next);
    },
  };
}

export interface RunResult {
  applied: boolean;
  rooms: RoomStatus[];
  migrated: number;
  skipped: number;
  failures: Array<{ roomId: string; stationKey: string; error: string }>;
}

/**
 * Describe every outstanding room, and — only when `apply` is true — migrate
 * each one, sequentially, one room at a time.
 *
 * One room per `migrateAgentMxids` call rather than the whole batch, so one
 * room's failure cannot abort the rest: a timeout or a rate limit on room 17
 * is caught, logged, and counted, and rooms 18 through 32 are still attempted.
 * A re-run is always the right response to a failure, because `describeRooms`
 * will find the same room still outstanding.
 */
export async function runMigration(
  describeDeps: DescribeDeps,
  client: DirectClient,
  opts: { apply: boolean }
): Promise<RunResult> {
  const rooms = await describeRooms(describeDeps);

  if (!opts.apply) {
    return { applied: false, rooms, migrated: 0, skipped: 0, failures: [] };
  }

  const deps = buildMigrationDeps(rooms, client);
  let migrated = 0;
  let skipped = 0;
  const failures: RunResult["failures"] = [];

  for (const room of rooms) {
    try {
      const r = await migrateAgentMxids({
        rooms: async () => [{ roomId: room.roomId, handle: room.handle, oldUserId: room.oldUserId }],
        join: deps.join,
        leave: deps.leave,
        setDirect: deps.setDirect,
      });
      migrated += r.migrated;
      skipped += r.skipped;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ roomId: room.roomId, stationKey: room.stationKey, error });
      log.error("a room's migration failed; continuing with the rest", {
        roomId: room.roomId,
        stationKey: room.stationKey,
        error,
      });
    }
  }

  return { applied: true, rooms, migrated, skipped, failures };
}

/** What an operator reads, whether this was a dry run or a real one. */
export function formatReport(result: RunResult): string {
  const lines: string[] = [];

  if (result.rooms.length === 0) {
    lines.push("No rooms need migration — every room already carries its new address.");
    return lines.join("\n");
  }

  lines.push(
    result.applied
      ? `Applying the migration to ${result.rooms.length} room(s).`
      : `DRY RUN — ${result.rooms.length} room(s) would be touched. Nothing has been changed.`
  );
  if (!result.applied) lines.push("Pass --apply to run this for real.");
  lines.push("");

  for (const r of result.rooms) {
    const steps = [
      r.joinOutstanding ? "join" : null,
      r.directOutstanding ? "m.direct" : null,
      r.leaveOutstanding ? "leave" : null,
    ]
      .filter((s): s is string => s !== null)
      .join(", ");
    lines.push(`  ${r.stationKey} @ ${r.nodeName}  (${r.roomId})`);
    lines.push(`    old: ${r.oldUserId}`);
    lines.push(`    new: ${r.newUserId}`);
    lines.push(`    outstanding: ${steps}`);
    if (!r.ownerMxid) {
      lines.push(`    warning: owner has no linked Matrix identity — m.direct cannot be fixed`);
    }
  }

  if (result.applied) {
    lines.push("");
    lines.push(`migrated ${result.migrated}, skipped ${result.skipped}, failed ${result.failures.length}`);
    for (const f of result.failures) {
      lines.push(`  FAILED ${f.stationKey} (${f.roomId}): ${f.error} — re-run to retry`);
    }
  }

  return lines.join("\n");
}

// ─── Live wiring — everything below touches the database and, with --apply, ───
// ─── the homeserver. None of it runs under `bun test`.                      ───

async function listRoomStations(): Promise<StationRoomRow[]> {
  return db
    .select({
      roomId: matrixRooms.roomId,
      stationId: stations.id,
      stationKey: stations.stationKey,
      nodeName: nodes.name,
      principalId: stations.principalId,
      ownerUserId: stations.userId,
    })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .innerJoin(nodes, eq(nodes.id, stations.nodeId));
}

/**
 * The owner's Matrix id, resolved exactly as `provision.ts`'s own `ownerMxid`
 * does — so the address this migration fixes `m.direct` for is the same one
 * provisioning invited in the first place.
 */
async function ownerMxidFor(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ externalId: principalIdentities.externalId })
    .from(principalIdentities)
    .where(
      and(eq(principalIdentities.principalId, userId), eq(principalIdentities.system, "matrix"))
    );
  return row?.externalId ?? null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const cfg = matrixBridgeConfig();
  const client = createMatrixClient({
    homeserverUrl: cfg.homeserverUrl,
    asToken: cfg.asToken,
    domain: cfg.domain,
  });

  const result = await runMigration(
    {
      domain: cfg.domain,
      rows: listRoomStations,
      isJoined: client.isJoined,
      principalHandle,
      ownerMxidFor,
    },
    client,
    { apply }
  );

  console.log(formatReport(result));

  if (result.failures.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((err) => {
    log.error("migration run crashed", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
