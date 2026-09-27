/**
 * Give every agent power over the room it lives in.
 *
 * ## What is wrong
 *
 * Agent mxids were migrated once: a station-derived `@agent_<node>_<station>`
 * became an occupant-derived `@agent_<handle>`. The old identity was retired
 * and left its rooms — but `m.room.power_levels` still names it, at 100, in
 * all thirty rooms. The live agent sits at the default of 0.
 *
 * So no agent can change any state in its own room. Setting
 * `m.room.encryption` needs 100, and so does changing a name, a topic or
 * anyone else's power. Every agent room is governed by an account that is not
 * in it and never will be again.
 *
 * Found while enabling encryption on one room: the only way through was to
 * invite the retired identity back, have it set the state, and send it away
 * again. That works once. It is not a way to run thirty rooms.
 *
 * ## What this does
 *
 * Per room, and only where it is needed:
 *
 *   1. the live agent invites the retired holder back (invite is 0, so it can)
 *   2. the holder joins
 *   3. the holder grants the live agent 100
 *   4. the holder leaves
 *
 * Both identities are inside the appservice's exclusive namespace, so all four
 * are ordinary impersonated calls. The retired identity is left at 100 rather
 * than demoted: taking power away from an account nobody can log into buys
 * nothing, and a room that ends up with no PL-100 holder at all cannot be
 * repaired by anyone.
 *
 * Idempotent, and a dry run by default:
 *
 *     bun run scripts/migrate-room-power.ts          # says what it would do
 *     bun run scripts/migrate-room-power.ts --apply  # does it
 */
import { eq } from "drizzle-orm";

import { closeDatabase, db } from "../src/db/drizzle";
import { matrixRooms } from "../src/db/schema/matrix";
import { stations } from "../src/db/schema/stations";

const HS = process.env.MATRIX_HOMESERVER_URL ?? "https://id.agentpod.dev";
const TOKEN = process.env.MATRIX_AS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply");

if (!TOKEN) {
  console.error("MATRIX_AS_TOKEN is required");
  process.exit(2);
}

const q = (s: string) => encodeURIComponent(s);

async function call(
  method: string,
  path: string,
  asUser: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const url = new URL(path, HS);
  url.searchParams.set("user_id", asUser);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** The rooms, with the identity each station actually speaks as. */
const rows = await db
  .select({
    roomId: matrixRooms.roomId,
    stationKey: stations.stationKey,
    live: stations.matrixId,
    bridge: stations.bridgeMatrixId,
  })
  .from(matrixRooms)
  .innerJoin(stations, eq(stations.id, matrixRooms.stationId));

console.log(`${APPLY ? "applying" : "dry run"}: ${rows.length} room(s)\n`);

let granted = 0;
let already = 0;
const failed: string[] = [];

for (const row of rows) {
  const live = (row.live ?? row.bridge ?? "").trim();
  if (!live) {
    failed.push(`${row.stationKey}: no mxid recorded`);
    continue;
  }

  const levels = await call(
    "GET",
    `/_matrix/client/v3/rooms/${q(row.roomId)}/state/m.room.power_levels`,
    live,
  );
  if (levels.status !== 200) {
    failed.push(`${row.stationKey}: cannot read power levels (${levels.status})`);
    continue;
  }

  const users: Record<string, number> = levels.body.users ?? {};
  if ((users[live] ?? levels.body.users_default ?? 0) >= 100) {
    already++;
    continue;
  }

  // Whoever can actually make the change. Preferring one still in the room
  // would be better, but after the mxid migration there is never one.
  const holder = Object.entries(users).find(([, level]) => level >= 100)?.[0];
  if (!holder) {
    failed.push(`${row.stationKey}: nobody holds 100, so nobody can grant it`);
    continue;
  }

  if (!APPLY) {
    console.log(`  would grant ${live} 100 in ${row.stationKey} (via ${holder})`);
    granted++;
    continue;
  }

  // The holder has left; it needs inviting before it can send state.
  await call("POST", `/_matrix/client/v3/rooms/${q(row.roomId)}/invite`, live, {
    user_id: holder,
  });
  const joined = await call("POST", `/_matrix/client/v3/rooms/${q(row.roomId)}/join`, holder, {});
  if (joined.status !== 200) {
    failed.push(`${row.stationKey}: the holder could not rejoin (${joined.status})`);
    continue;
  }

  const set = await call(
    "PUT",
    `/_matrix/client/v3/rooms/${q(row.roomId)}/state/m.room.power_levels`,
    holder,
    { ...levels.body, users: { ...users, [live]: 100 } },
  );

  // Out again whatever happened: a second agent identity sitting in a DM is
  // the confusion the mxid migration existed to remove.
  await call("POST", `/_matrix/client/v3/rooms/${q(row.roomId)}/leave`, holder, {});

  if (set.status !== 200) {
    failed.push(`${row.stationKey}: the grant was refused (${set.status} ${set.body.errcode ?? ""})`);
    continue;
  }
  console.log(`  ok  ${row.stationKey} — ${live} now holds 100`);
  granted++;
}

console.log(
  `\n${granted} ${APPLY ? "granted" : "to grant"}, ${already} already held, ${failed.length} failed`,
);
for (const f of failed) console.log(`  FAIL ${f}`);
await closeDatabase();
if (failed.length) process.exit(1);
