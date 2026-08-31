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
 * check would silently skip a room that is only half done. Membership is
 * checked live with `client.isJoined`, and `m.direct` is checked live too, by
 * reading it back rather than inferring it from the other two: join and leave
 * no longer imply anything about `m.direct` (see below), so its own state has
 * to be read directly for a room to ever stop being reported.
 *
 * ## `m.direct` is optional, and never blocks the membership move
 *
 * `client.ts`'s own note on `ensureRoom`'s `isDirect` — written before this
 * file existed — already concluded that writing a human's account data needs
 * a credential this bridge exists to stop keeping; the tuwunel spike never
 * tested `account_data` at all, and only ever proved `?user_id=` masquerading
 * for identities *inside* `@agent_.*`. So a refusal here is the expected case,
 * not a bug, and it must never be the thing that leaves a room stuck: if
 * `setDirect` were allowed to throw, `migrateAgentMxids`'s own join-then-
 * setDirect-then-leave order would abort before the old user ever leaves,
 * and every room refused this way would end up with BOTH agents present,
 * `m.direct` untouched, and an identical refusal on every re-run. `setDirect`
 * therefore catches its own failure, records it, and always returns
 * normally — membership always finishes moving, whether or not this bridge
 * turns out to be allowed to fix the DM flag. Whether to pursue `m.direct` by
 * some other route (a one-time use of a human's own token, say) is the
 * operator's call, not this script's: it is a real cost — 32 rooms silently
 * dropping out of People — traded against the charter principle that this
 * bridge holds no human credential, and that trade is reported here, not
 * made here.
 *
 * ## `M_EXCLUSIVE` is permanent, not transient — settled 2026-08-30
 *
 * A probe against the live homeserver answered the question the paragraph
 * above only speculated about: `GET account_data` as the operator comes back
 * `400 M_EXCLUSIVE — User is not in namespace.` The AS's exclusive namespace
 * is `@agent_.*`; the operator's own mxid is outside it; no retry, backoff,
 * or re-run changes that. This is why `describeRooms` tells `M_EXCLUSIVE`
 * apart from every other read failure (`isMatrixExclusiveNamespace`, from
 * `client.ts`): a genuine transient error must still fail closed and read as
 * `directOutstanding`, but `M_EXCLUSIVE` must not — reporting it as
 * outstanding forever, on every run, for all 32 rooms, is worse than a known
 * limitation, because it buries the rooms that actually need attention under
 * noise that can never clear. Such a room's `m.direct` reads as
 * `directExcluded`, not outstanding, and — per "completion is join + leave"
 * below — stops being reported at all once its membership has moved. The
 * fact itself is not lost: `describeRooms` also returns `mDirectExcluded`,
 * and `formatReport` states it once, at the top, in every report where it
 * was true this run. The honest close for the DM mapping is a one-off run
 * using the OPERATOR'S OWN access token, not the bridge's — that token is
 * inside no `@agent_.*` namespace restriction, because it is not the
 * bridge's credential to hold. This script cannot do that run; it can only
 * say, plainly, that the remaining work exists and whose token closes it.
 *
 * ## Completion is join + leave
 *
 * `M_EXCLUSIVE` means `m.direct` can never be fixed through this bridge, and
 * a room whose join and leave are both done is, for this migration's
 * purposes, done — it must not stay on the report forever over a step that
 * is structurally impossible here. `directExcluded` is what keeps that
 * honest instead of silent: it says the step was excluded on purpose, not
 * forgotten, which is why `formatReport` still names it once even once no
 * room is left outstanding.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../src/db/drizzle";
import { stations } from "../src/db/schema/stations";
import { nodes } from "../src/db/schema/nodes";
import { matrixRooms } from "../src/db/schema/matrix";
import { principalIdentities } from "../src/db/schema/identities";
import { principalHandle, principalForUser } from "../src/services/principals";
import { bridgeUserId, localpartFor } from "../src/services/matrix-as/names";
import { createMatrixClient, isMatrixExclusiveNamespace } from "../src/services/matrix-as/client";
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
  /**
   * True until `m.direct` is actually read back naming the new user for this
   * room, UNLESS `directExcluded` is true (see below) — a permanently
   * excluded room reads as not-applicable, never as outstanding, no matter
   * how many times this is checked. Not inferred from
   * `joinOutstanding`/`leaveOutstanding` — a refused `m.direct` write no
   * longer blocks `leave` (see the file doc), so a room can have finished
   * moving membership while this stays true forever, and that must stay
   * visible rather than making the room vanish from the report.
   */
  directOutstanding: boolean;
  /**
   * True when reading `m.direct` for this room's owner failed with
   * `M_EXCLUSIVE` — the appservice acting as a user outside its own
   * namespace, confirmed permanent (see the file doc). Mutually exclusive
   * with `directOutstanding`: this is the "not applicable" reading, not the
   * "still needs work" one, and it is what lets a room whose join and leave
   * are both done stop being reported at all.
   */
  directExcluded: boolean;
}

/** What `describeRooms` needs to ask a Matrix client. */
export interface DescribeClient {
  isJoined(userId: string, roomId: string): Promise<boolean>;
  getAccountData(userId: string, type: string): Promise<Record<string, unknown> | null>;
}

export interface DescribeDeps {
  domain: string;
  rows(): Promise<StationRoomRow[]>;
  client: DescribeClient;
  principalHandle(id: string): Promise<string | null>;
  ownerMxidFor(userId: string): Promise<string | null>;
}

/** The three things a room's `m.direct` state can turn out to be. */
type DirectCheck = "done" | "outstanding" | "excluded";

/**
 * Whether the owner's `m.direct` already names `newUserId` for this room —
 * or, if it can never be read at all, whether that is a real, retriable
 * failure or the permanent `M_EXCLUSIVE` case (see the file doc).
 *
 * These three outcomes must not collapse into two: `"excluded"` is a fact
 * about this bridge's reach, settled once and for all by a live probe, and
 * conflating it with `"outstanding"` is exactly the defect this function
 * exists to avoid — 32 rooms reported as needing work that can never be
 * done, forever, on every run.
 */
async function checkDirect(
  client: DescribeClient,
  ownerMxid: string | null,
  newUserId: string,
  roomId: string
): Promise<DirectCheck> {
  if (!ownerMxid) return "outstanding"; // nothing this script can do is still "not done"
  try {
    const current = await client.getAccountData(ownerMxid, "m.direct");
    const rooms = current && Array.isArray(current[newUserId]) ? (current[newUserId] as unknown[]) : [];
    return rooms.includes(roomId) ? "done" : "outstanding";
  } catch (err) {
    if (isMatrixExclusiveNamespace(err)) {
      // Permanent, not transient — confirmed live. Reported as excluded, not
      // outstanding, so a room whose membership has fully moved is not kept
      // on the report forever over a step that can never be done here.
      log.warn(
        "m.direct cannot be read as the owner — outside the appservice's namespace; reporting as not applicable, not outstanding",
        { roomId }
      );
      return "excluded";
    }
    // A genuine, retriable failure is reported as outstanding, not silently
    // treated as fixed — the same "fail closed" stance `setDirect` takes on
    // a write. This must stay a different fact from `M_EXCLUSIVE` above: a
    // transient error deserves a re-run, not a permanent write-off.
    log.warn("could not read m.direct while describing this room; reporting it as outstanding", {
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "outstanding";
  }
}

/** What `describeRooms` reports: the outstanding rooms, and one run-wide fact. */
export interface DescribeRoomsResult {
  rooms: RoomStatus[];
  /**
   * True when at least one room's `m.direct` read failed with `M_EXCLUSIVE`
   * this run. The one fact `formatReport` states at the top, once — never
   * per room — because it is the same fact for all 32 rooms: this bridge
   * cannot act as the operator, permanently, and no re-run changes it.
   */
  mDirectExcluded: boolean;
}

/**
 * Every room that still needs some of this migration, and nothing else.
 *
 * A room is left out once join, leave, AND `m.direct` are all settled —
 * `m.direct` either confirmed fixed by reading it back, or `excluded`
 * (`M_EXCLUSIVE`, permanent — see the file doc). A refused-but-retriable
 * `m.direct` read is the one case that must keep a room visible even after
 * membership has fully moved; `excluded` deliberately is not that case.
 */
export async function describeRooms(deps: DescribeDeps): Promise<DescribeRoomsResult> {
  const out: RoomStatus[] = [];
  let mDirectExcluded = false;

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
    const ownerMxid = await deps.ownerMxidFor(row.ownerUserId);

    const newJoined = await deps.client.isJoined(newUserId, row.roomId);
    const oldStillJoined = await deps.client.isJoined(oldUserId, row.roomId);
    const direct = await checkDirect(deps.client, ownerMxid, newUserId, row.roomId);
    if (direct === "excluded") mDirectExcluded = true;

    const joinOutstanding = !newJoined;
    const leaveOutstanding = oldStillJoined;
    const directOutstanding = direct === "outstanding";
    const directExcluded = direct === "excluded";

    if (!joinOutstanding && !leaveOutstanding && !directOutstanding) continue; // truly nothing left — completion is join + leave, and m.direct is done or excluded

    out.push({
      roomId: row.roomId,
      stationKey: row.stationKey,
      nodeName: row.nodeName,
      handle,
      oldUserId,
      newUserId,
      ownerMxid,
      joinOutstanding,
      leaveOutstanding,
      directOutstanding,
      directExcluded,
    });
  }

  return { rooms: out, mDirectExcluded };
}

/** What `buildMigrationDeps` needs from a live (or fake) Matrix client. */
export interface DirectClient {
  join(userId: string, roomId: string): Promise<void>;
  leave(userId: string, roomId: string): Promise<void>;
  getAccountData(userId: string, type: string): Promise<Record<string, unknown> | null>;
  setAccountData(userId: string, type: string, content: Record<string, unknown>): Promise<void>;
}

/** How `m.direct` went for one room, once `setDirect` has run for it. */
export type DirectOutcome =
  | { status: "fixed" }
  | { status: "no-owner" }
  | { status: "failed"; error: string };

/**
 * Wire `RoomStatus[]` into the deps shape `migrateAgentMxids` consumes.
 *
 * `setDirect` is where the read-modify-write lives: `m.direct` is every DM
 * the owner has, not just this one, so this reads the map, changes only the
 * two keys this room touches, and writes the whole thing back. It is also
 * where a refusal is caught rather than thrown — `migrateAgentMxids` calls
 * `leave` right after this returns, and that call must still happen whether
 * or not the write above succeeded. `directOutcomes` is how the caller finds
 * out which happened, since `setDirect`'s own return type carries nothing.
 */
export function buildMigrationDeps(
  rooms: RoomStatus[],
  client: DirectClient
): { deps: MxidMigrationDeps; directOutcomes: Map<string, DirectOutcome> } {
  const byRoom = new Map(rooms.map((r) => [r.roomId, r]));
  const directOutcomes = new Map<string, DirectOutcome>();

  const deps: MxidMigrationDeps = {
    rooms: async () => rooms.map((r) => ({ roomId: r.roomId, handle: r.handle, oldUserId: r.oldUserId })),
    join: (userId, roomId) => client.join(userId, roomId),
    leave: (userId, roomId) => client.leave(userId, roomId),
    async setDirect(newUserId, roomId) {
      const room = byRoom.get(roomId);
      if (!room?.ownerMxid) {
        log.warn("cannot fix m.direct: the room's owner has no linked Matrix identity", {
          roomId,
        });
        directOutcomes.set(roomId, { status: "no-owner" });
        return;
      }

      try {
        const current = (await client.getAccountData(room.ownerMxid, "m.direct")) ?? {};
        const next: Record<string, unknown> = { ...current };

        const oldRooms = Array.isArray(next[room.oldUserId]) ? (next[room.oldUserId] as unknown[]) : [];
        const remaining = oldRooms.filter((r) => r !== roomId);
        if (remaining.length > 0) next[room.oldUserId] = remaining;
        else delete next[room.oldUserId];

        const newRooms = Array.isArray(next[newUserId]) ? (next[newUserId] as unknown[]) : [];
        if (!newRooms.includes(roomId)) next[newUserId] = [...newRooms, roomId];

        await client.setAccountData(room.ownerMxid, "m.direct", next);
        directOutcomes.set(roomId, { status: "fixed" });
      } catch (err) {
        // Not fatal, and deliberately so: see the file doc. The membership
        // move must complete regardless of whether this bridge turns out to
        // be allowed to touch the owner's account data.
        const error = err instanceof Error ? err.message : String(err);
        log.warn(
          "could not fix m.direct for this room; leaving membership to move anyway",
          { roomId, error }
        );
        directOutcomes.set(roomId, { status: "failed", error });
      }
    },
  };

  return { deps, directOutcomes };
}

/** One room's outcome after an apply run has actually touched it. */
export interface RoomResult {
  roomId: string;
  stationKey: string;
  /** Set only when `join` or `leave` threw and aborted this room's migration. */
  error?: string;
  /** Null when the room's migration failed before `setDirect` ever ran. */
  direct: DirectOutcome | null;
}

export interface RunResult {
  applied: boolean;
  rooms: RoomStatus[];
  /** See `DescribeRoomsResult` — the one run-wide fact `formatReport` states once. */
  mDirectExcluded: boolean;
  migrated: number;
  skipped: number;
  failures: Array<{ roomId: string; stationKey: string; error: string }>;
  /** Per-room detail for an apply run; empty for a dry run. */
  results: RoomResult[];
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
  const { rooms, mDirectExcluded } = await describeRooms(describeDeps);

  if (!opts.apply) {
    return { applied: false, rooms, mDirectExcluded, migrated: 0, skipped: 0, failures: [], results: [] };
  }

  const { deps, directOutcomes } = buildMigrationDeps(rooms, client);
  let migrated = 0;
  let skipped = 0;
  const failures: RunResult["failures"] = [];
  const results: RoomResult[] = [];

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
      results.push({
        roomId: room.roomId,
        stationKey: room.stationKey,
        direct: directOutcomes.get(room.roomId) ?? null,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ roomId: room.roomId, stationKey: room.stationKey, error });
      results.push({
        roomId: room.roomId,
        stationKey: room.stationKey,
        error,
        direct: directOutcomes.get(room.roomId) ?? null,
      });
      log.error("a room's migration failed; continuing with the rest", {
        roomId: room.roomId,
        stationKey: room.stationKey,
        error,
      });
    }
  }

  return { applied: true, rooms, mDirectExcluded, migrated, skipped, failures, results };
}

function describeDirectOutcome(outcome: DirectOutcome | null): string {
  if (!outcome) return "m.direct: not attempted";
  if (outcome.status === "fixed") return "m.direct: fixed";
  if (outcome.status === "no-owner") return "m.direct: skipped — owner has no linked Matrix identity";
  return `m.direct: skipped — ${outcome.error}`;
}

/**
 * The `M_EXCLUSIVE` note — stated once, at the top, never per room. See the
 * file doc's "`M_EXCLUSIVE` is permanent, not transient" section for the
 * full story; this is the short form an operator reads before anything else.
 */
const M_DIRECT_EXCLUDED_NOTE =
  "NOTE: m.direct (the operator's own DM mapping) cannot be updated through this bridge. " +
  "Reading it as the operator gets 400 M_EXCLUSIVE — the operator's own mxid sits outside " +
  "the appservice's exclusive @agent_.* namespace, confirmed live, and that is permanent, " +
  "not a bug here. Room membership (join and leave) still moves in full for every room below; " +
  "closing the DM mapping needs a one-off run using the operator's OWN access token, not the " +
  "bridge's. Rooms below show this step as 'not applicable', not outstanding.";

/** What an operator reads, whether this was a dry run or a real one. */
export function formatReport(result: RunResult): string {
  const lines: string[] = [];

  if (result.mDirectExcluded) {
    lines.push(M_DIRECT_EXCLUDED_NOTE);
    lines.push("");
  }

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
    lines.push(`    outstanding: ${steps || "none"}`);
    if (r.directExcluded) {
      lines.push(`    m.direct: not applicable — see note above`);
    }
    if (!r.ownerMxid) {
      lines.push(`    warning: owner has no linked Matrix identity — m.direct cannot be fixed`);
    }
  }

  if (result.applied) {
    lines.push("");
    lines.push(`migrated ${result.migrated}, skipped ${result.skipped}, failed ${result.failures.length}`);
    lines.push("");
    for (const r of result.results) {
      lines.push(
        r.error
          ? `  FAILED ${r.stationKey} (${r.roomId}): ${r.error} — re-run to retry`
          : `  ${r.stationKey} (${r.roomId}): membership updated, ${describeDirectOutcome(r.direct)}`
      );
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
 *
 * That parity claim was written while both functions were wrong in the same
 * way, which is the worst thing a parity claim can be: `stations.userId` is a
 * Better Auth id, `principal_identities.principal_id` holds `prn_…` values,
 * and querying that column with a user id resolved null for every room in the
 * fleet — so `m.direct` was never written and every room reported its DM flag
 * outstanding forever. Both now resolve the principal first, and the parity is
 * a fact rather than a hope: change one and this must change with it.
 */
async function ownerMxidFor(userId: string): Promise<string | null> {
  const principal = await principalForUser(userId);
  if (!principal) return null;

  const [row] = await db
    .select({ externalId: principalIdentities.externalId })
    .from(principalIdentities)
    .where(
      and(
        eq(principalIdentities.principalId, principal.id),
        eq(principalIdentities.system, "matrix")
      )
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
      client,
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
