/**
 * Which of a station's unbound rooms belongs to its occupant — one rule,
 * four sites.
 *
 * `matrix_rooms_station_idx` stopped being unique in an earlier fix round so
 * a departed occupant's room could sit beside its successor's. That made
 * "which unbound room?" a real question, and the whole-branch review found
 * it being answered four different ways, three of them by an unordered
 * `LIMIT 1` — including in the LIVE writer, in exactly the state migration
 * `0062` was politely declining to guess in.
 *
 * The rule is **oldest `created_at`, tie-broken by `room_id`**: the
 * station's original room is the one carrying the history this slice exists
 * to preserve. `station-room.ts`'s `unboundRoomsForStation` states it;
 * `0062`'s own coverage lives in `db/drizzle-migrations/`.
 *
 * **On the fixtures.** A station carrying two unbound rooms is not a state
 * production can reach any more — `provision.ts` binds at creation — so it
 * is legacy data by construction: rows from before this column had a
 * writer, or rows `0060` skipped. The older room here is created by the
 * REAL `provisionStation` wherever it can be; the row that is hand-inserted
 * is the DECOY, the one the rule must not pick. Nothing hand-writes the
 * binding that is the thing under test.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { createTestUser } from "../../../tests/helpers/database";
import { db, rawSql } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { matrixRooms } from "../../db/schema/matrix";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { mintEnrollmentToken, enrollNode } from "../enrollment";
import { adoptStations } from "../station-registry";
import { adminMiddleware } from "../../auth/admin-middleware";
import { agentsAdminRouter } from "../../routes/agents-admin";
import { createPrincipal } from "../principals";
import { onProvisionStation } from "./hooks";
import { provisionStation } from "./provision";
import { roomForStation, roomAliasForStation } from "./station-room";

const DOMAIN = "id.agentpod.dev";
const RUN = crypto.randomUUID().slice(0, 8);
const ACTOR = `test-admin-unbound-${RUN}`;
const HANDLE = `unbound-rule-${RUN}`;

let nodeId: string;

const app = (() => {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: ACTOR, authType: "api_key", tenantId: "default" });
    await next();
  });
  a.use("*", adminMiddleware);
  a.route("/", agentsAdminRouter);
  return a;
})();

async function assign(stationId: string, principalId: string) {
  const res = await app.request(`/stations/${stationId}/agent`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId }),
  });
  expect(res.status).toBe(200);
}

async function adopt(key: string, matrixId?: string) {
  const [row] = await adoptStations(ACTOR, nodeId, [key], [
    {
      key,
      ...(matrixId ? { matrixId } : {}),
      harness: "opencode",
      kind: "leaf",
      displayName: `Station ${key}`,
      parentKey: null,
      workspacePath: null,
      capabilities: ["acp"],
      adopted: false,
    },
  ]);
  return row!.id;
}

/**
 * The REAL provisioning path, with only the homeserver faked.
 *
 * Driven against a HARNESS-mode station, because that is the one shape whose
 * room provisioning genuinely creates while nobody occupies it —
 * `provision.ts` returns early for bridge mode with no occupant, which is
 * the very early-return the Critical turned on. So the unbound room these
 * tests choose between is produced by production code rather than asserted
 * into existence.
 */
async function provisionReal(stationId: string, roomId: string) {
  await provisionStation(stationId, {
    domain: DOMAIN,
    client: {
      ensureUser: async () => {},
      ensureRoom: async () => roomId,
      invite: async () => {},
    },
  });
}

/**
 * A room from before `principal_id` had a writer. Hand-inserted because
 * nothing can create one any more — and, in every test below, this is the
 * room the rule must NOT choose.
 */
async function legacyRoom(stationId: string, roomId: string, createdAt: string) {
  await db.insert(matrixRooms).values({
    roomId,
    tenantId: BOOTSTRAP_TENANT_ID,
    stationId,
    alias: `#legacy-${roomId.slice(1, 12)}:${DOMAIN}`,
    createdAt: new Date(createdAt),
  });
}

/** A station that answers for itself, so provisioning can make it a room. */
async function adoptHarness(key: string) {
  const stationId = await adopt(key, `@harness-${key.replace(/[^a-z0-9]/g, "-")}:${DOMAIN}`);
  await db
    .update(stations)
    .set({ matrixIdentityMode: "harness" })
    .where(eq(stations.id, stationId));
  return stationId;
}

async function principalOf(roomId: string) {
  const [row] = await db
    .select({ principalId: matrixRooms.principalId })
    .from(matrixRooms)
    .where(eq(matrixRooms.roomId, roomId));
  return row?.principalId ?? null;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: ACTOR,
    email: `unbound-rule-${RUN}@example.com`,
    name: "Actor",
    role: "admin",
  });
  const { token } = await mintEnrollmentToken(ACTOR);
  const enrolled = await enrollNode(token, {
    hostname: `unbound-rule-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 1,
  });
  nodeId = enrolled.nodeId;
  // No bridge for these tests unless a test asks for one: they are about
  // which EXISTING room gets chosen, not about creating new ones.
  onProvisionStation(null);
});

afterAll(async () => {
  onProvisionStation(null);
  try {
    await rawSql`DELETE FROM stations WHERE user_id = ${ACTOR}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${ACTOR}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${ACTOR}`;
    await rawSql`DELETE FROM principals WHERE handle LIKE ${HANDLE + "%"}`;
    await rawSql`DELETE FROM "user" WHERE id = ${ACTOR}`;
  } catch {
    // cleanup only
  }
});

describe("bind-on-assign chooses the oldest unbound room", () => {
  test("the station's original room wins over a newer sibling, whatever order they were written in", async () => {
    const stationId = await adoptHarness(`opencode:${RUN}-bind`);

    // The ORIGINAL room, made by the real provisioning path while the
    // station had no occupant — the room an operator has been reading.
    // Provisioned FIRST because `provision.ts` creates a room only when the
    // station has none, so a decoy inserted before it would suppress it.
    const original = `!original-${RUN}:${DOMAIN}`;
    await provisionReal(stationId, original);
    expect(await principalOf(original), "provisioned unoccupied, so unbound").toBeNull();

    const newer = `!newer-${RUN}:${DOMAIN}`;
    await legacyRoom(stationId, newer, "2026-06-01T00:00:00Z");

    // Backdating the original is what makes it the older of the two — AND,
    // deliberately, what puts it LAST in Postgres's heap order, since an
    // UPDATE writes a new tuple at the end. Heap order is what an unordered
    // `LIMIT 1` reads, so after this line the two orders disagree and
    // removing the rule becomes observable. Without that, this test would
    // pass by luck whether the rule were applied or not.
    await rawSql`UPDATE matrix_rooms SET created_at = ${"2026-01-01T00:00:00Z"} WHERE room_id = ${original}`;

    const principalId = await createPrincipal({ kind: "agent", handle: `${HANDLE}-bind` });
    await assign(stationId, principalId);

    expect(
      await principalOf(original),
      "the agent inherits the station's ORIGINAL room and its history"
    ).toBe(principalId);
    expect(await principalOf(newer), "the newer sibling is left alone").toBeNull();
  });

  test("two rooms created in the same instant: room_id breaks the tie deterministically", async () => {
    const stationId = await adopt(`opencode:${RUN}-tie`);
    const sameInstant = "2026-04-01T00:00:00Z";
    // `!tie-a…` sorts before `!tie-b…`, and is inserted SECOND.
    await legacyRoom(stationId, `!tie-b-${RUN}:${DOMAIN}`, sameInstant);
    await legacyRoom(stationId, `!tie-a-${RUN}:${DOMAIN}`, sameInstant);

    const principalId = await createPrincipal({ kind: "agent", handle: `${HANDLE}-tie` });
    await assign(stationId, principalId);

    expect(await principalOf(`!tie-a-${RUN}:${DOMAIN}`)).toBe(principalId);
    expect(await principalOf(`!tie-b-${RUN}:${DOMAIN}`)).toBeNull();
  });
});

describe("roomForStation's unbound fallback is stable", () => {
  test("an unoccupied station with two unbound rooms resolves to the same one every time — one conversation, not two", async () => {
    const stationId = await adoptHarness(`opencode:${RUN}-stable`);
    const original = `!stable-original-${RUN}:${DOMAIN}`;
    await provisionReal(stationId, original);
    await legacyRoom(stationId, `!stable-newer-${RUN}:${DOMAIN}`, "2026-07-01T00:00:00Z");
    // Same construction as above: the backdating UPDATE also moves the
    // original to the end of the heap, so heap order and the rule disagree.
    await rawSql`UPDATE matrix_rooms SET created_at = ${"2026-02-01T00:00:00Z"} WHERE room_id = ${original}`;

    // `station-say.ts` and `gates.ts` both ask this question, separately.
    // Before the rule, an unordered LIMIT 1 could answer each of them with a
    // different room and split one conversation across two.
    const answers = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const room = (await roomForStation(stationId)).room;
      expect(room).not.toBeNull();
      answers.add(room!.roomId);
    }
    expect(answers.size, "every reader gets the same room").toBe(1);
    expect([...answers][0], "and it is the station's original").toBe(original);
  });
});

describe("roomAliasForStation reports where a room IS, not where one would be", () => {
  test("an occupied station whose occupant holds no bound room answers with the sibling's STORED alias", async () => {
    // The state, reached through the real routes: the agent is assigned to a
    // station whose only room is already someone else's, on a hub with no
    // bridge — so nothing binds and nothing is provisioned. The unbound
    // legacy sibling arrives afterwards, the way `0060`-skipped rows did.
    const stationId = await adopt(`opencode:${RUN}-alias`);
    const holder = `!alias-holder-${RUN}:${DOMAIN}`;
    const departed = await createPrincipal({ kind: "agent", handle: `${HANDLE}-departed` });
    await legacyRoom(stationId, holder, "2026-01-01T00:00:00Z");
    await assign(stationId, departed); // binds `holder` to the departed agent

    const occupant = await createPrincipal({ kind: "agent", handle: `${HANDLE}-occupant` });
    await assign(stationId, occupant); // nothing left to bind, no bridge to provision
    expect(
      (await roomForStation(stationId)).room,
      "the occupant honestly has no room of its own"
    ).toBeNull();

    const legacy = `!alias-legacy-${RUN}:${DOMAIN}`;
    await legacyRoom(stationId, legacy, "2026-03-01T00:00:00Z");
    const legacyAlias = `#legacy-${legacy.slice(1, 12)}:${DOMAIN}`;

    expect(
      await roomAliasForStation(stationId, DOMAIN),
      "the address a room actually holds, not a derivation for a room that does not exist"
    ).toBe(legacyAlias);

    // The derivation is still what answers when there is genuinely no room.
    const bare = await adopt(`opencode:${RUN}-bare`);
    const alias = await roomAliasForStation(bare, DOMAIN);
    expect(alias, "a station with no room at all still gets 'where it will be'").toMatch(
      /^#agentpod_/
    );
  });
});
