/**
 * The slice's exit test: adopt → create an agent → assign → gate, with no
 * SQL and **no hand-called `provisionStation` anywhere in it**.
 *
 * That last clause is the whole reason this file exists. The whole-branch
 * review found that assigning an agent wrote `stations.principal_id`,
 * conditionally bound an existing unbound room, and never provisioned —
 * and that a fully green suite could not see it, because every test in this
 * area called `provisionStation` by hand after assigning. The manual call
 * supplied the exact step production omitted, so the tests proved the half
 * of the chain that worked and silently stood in for the half that did not.
 *
 * The consequence in production was invisible and permanent:
 * `stations.matrix_identity_mode` defaults to `bridge`, `provision.ts`
 * returns early for a bridge-mode station with no occupant, and adoption
 * fires before there IS an occupant. So adoption made no room, assignment
 * made no room, `roomForStation` answered `room: null`, `projectGate`
 * returned `no-room`, and `gate-sweep.ts` does not count that status.
 * Nobody would have learned until somebody restarted the hub.
 *
 * Everything below drives the REAL surfaces: the real station registry for
 * adoption, the real `POST /api/admin/agents` and
 * `PUT /api/admin/stations/:id/agent` behind the real admin guard, and the
 * real `projectGate`. Only the homeserver is faked — and `bridge_dispatches`
 * is inserted directly, because that row is kaambaan's record of work this
 * fleet already did, not the thing under test.
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
import { nodes } from "../../db/schema/nodes";
import { matrixRooms } from "../../db/schema/matrix";
import { bridgeDispatches } from "../../db/schema/bridge";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { mintEnrollmentToken, enrollNode } from "../enrollment";
import { adoptStations } from "../station-registry";
import { adminMiddleware } from "../../auth/admin-middleware";
import { agentsAdminRouter } from "../../routes/agents-admin";
import { onProvisionStation, onStationsAdopted } from "./hooks";
import { provisionStation } from "./provision";
import { roomForStation } from "./station-room";
import { projectGate } from "./gates";
import { bridgeUserId } from "./names";
import type { GatePendingDelivery } from "./gates";

const DOMAIN = "id.agentpod.dev";
const RUN = crypto.randomUUID().slice(0, 8);
const ACTOR = `test-admin-assign-prov-${RUN}`;
const HANDLE = `assign-prov-${RUN}`;

let nodeId: string;

/**
 * The homeserver, faked at the only place this suite touches it. Every room
 * id it mints is fresh and recorded, so "a room was created" is an
 * observation rather than an assumption.
 */
function fakeHomeserver() {
  const ensuredRooms: Array<{ alias: string; creator: string }> = [];
  const ensuredUsers: string[] = [];
  return {
    ensuredRooms,
    ensuredUsers,
    deps: {
      domain: DOMAIN,
      client: {
        ensureUser: async (localpart: string) => {
          ensuredUsers.push(localpart);
        },
        ensureRoom: async (alias: string, opts: { creator: string }) => {
          ensuredRooms.push({ alias, creator: opts.creator });
          return `!provisioned-${crypto.randomUUID().slice(0, 8)}:${DOMAIN}`;
        },
        invite: async () => {},
      },
    },
  };
}

/** The admin API, behind its real guard. */
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

async function createAgent(handle: string): Promise<string> {
  const res = await app.request("/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function assign(stationId: string, principalId: string) {
  const res = await app.request(`/stations/${stationId}/agent`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Adopt one station the way a node agent does — through the real registry. */
async function adopt(key: string, extra: { matrixId?: string } = {}) {
  const [row] = await adoptStations(ACTOR, nodeId, [key], [
    {
      key,
      harness: "opencode",
      kind: "leaf",
      displayName: `Station ${key}`,
      parentKey: null,
      workspacePath: null,
      capabilities: ["acp"],
      adopted: false,
      ...extra,
    },
  ]);
  expect(row, "the registry adopted the station").toBeTruthy();
  return row!.id;
}

function delivery(gateId: string, cardId: string): GatePendingDelivery {
  return {
    event: "gate.pending",
    boardId: `brd_${RUN}`,
    cardId,
    gateId,
    stageKey: "review",
    returnStageKey: "code",
    cardTitle: "Ship the fix",
    producedBy: "agt_x",
    options: [{ id: "approve", label: "Approve" }],
    ts: "2026-08-31T00:00:00.000Z",
  };
}

function gateDeps() {
  const sent: Array<{ userId: string; roomId: string }> = [];
  return {
    sent,
    deps: {
      domain: DOMAIN,
      sendText: async (userId: string, roomId: string) => {
        sent.push({ userId, roomId });
        return `$prose-${crypto.randomUUID()}`;
      },
      sendCustomEvent: async (userId: string, roomId: string) => {
        sent.push({ userId, roomId });
        return `$gate-${crypto.randomUUID()}`;
      },
    },
  };
}

/** kaambaan's record that this fleet ran the card. Not the thing under test. */
async function dispatched(stationId: string, cardId: string) {
  await db.insert(bridgeDispatches).values({
    externalSource: "kaambaan",
    externalRunId: `run_${cardId}`,
    tenantId: BOOTSTRAP_TENANT_ID,
    boardId: `brd_${RUN}`,
    externalCardId: cardId,
    agentKey: "test",
    stationId,
    leaseEpoch: 1,
    outcome: "produced",
    startedAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: ACTOR,
    email: `assign-prov-${RUN}@example.com`,
    name: "Actor",
    role: "admin",
  });
  const { token } = await mintEnrollmentToken(ACTOR);
  const enrolled = await enrollNode(token, {
    hostname: `assign-prov-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 1,
  });
  nodeId = enrolled.nodeId;
});

afterAll(async () => {
  onProvisionStation(null);
  onStationsAdopted(null);
  try {
    await rawSql`DELETE FROM matrix_gate_events WHERE tenant_id = ${BOOTSTRAP_TENANT_ID} AND board_id = ${"brd_" + RUN}`;
    await rawSql`DELETE FROM bridge_dispatches WHERE tenant_id = ${BOOTSTRAP_TENANT_ID} AND board_id = ${"brd_" + RUN}`;
    await rawSql`DELETE FROM stations WHERE user_id = ${ACTOR}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${ACTOR}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${ACTOR}`;
    await rawSql`DELETE FROM principals WHERE handle LIKE ${HANDLE + "%"}`;
    await rawSql`DELETE FROM "user" WHERE id = ${ACTOR}`;
  } catch {
    // cleanup only
  }
});

describe("assigning an agent provisions its station", () => {
  test("adopt → create → assign → gate lands in a room nothing in this test provisioned by hand", async () => {
    const hs = fakeHomeserver();
    // Boot wiring, exactly as `index.ts` does it: BOTH triggers registered,
    // so nothing here is reaching past a path production also has.
    onStationsAdopted(async (ids) => {
      for (const id of ids) await provisionStation(id, hs.deps);
    });
    onProvisionStation((id) => provisionStation(id, hs.deps));

    const stationId = await adopt(`opencode:${RUN}-exit`);

    // Adoption alone gives a bridge-mode station with no occupant nothing —
    // `provision.ts` returns early. Asserted rather than assumed, because it
    // is the first half of the gap: the room does not arrive here.
    // `notifyStationsAdopted` is fire-and-forget, so give it a real
    // round-trip to have happened in before looking.
    await db.select({ id: stations.id }).from(stations).where(eq(stations.id, stationId));
    expect(await roomForStation(stationId)).toEqual({ principalId: null, room: null });

    const principalId = await createAgent(HANDLE);

    // The act under test. After this line NOTHING in this test provisions.
    const assigned = await assign(stationId, principalId);
    expect(assigned.status).toBe(200);
    expect(
      assigned.body.room,
      "the response says plainly whether the agent got a room"
    ).toEqual({ status: "provisioned" });

    // THE GATE, asserted first and deliberately: it is the end of the chain
    // the slice exists to make work, and it is the assertion that fails when
    // assignment stops provisioning. Everything after it is corroboration.
    const cardId = `crd_${RUN}_exit`;
    await dispatched(stationId, cardId);
    const { deps, sent } = gateDeps();
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, delivery(`gate_${RUN}_exit`, cardId), deps);

    expect(
      outcome.status,
      "the gate is sent — 'no-room' here is the Critical, and gate-sweep does not count it"
    ).toBe("sent");

    // The room it landed in was really created by the fake homeserver during
    // the assign call, rather than found lying around, and belongs to THIS
    // agent.
    expect(hs.ensuredRooms, "assignment created exactly one room").toHaveLength(1);
    expect(hs.ensuredUsers, "and registered the agent's bridge identity").toEqual([
      `agent_${HANDLE}`,
    ]);
    const occupancy = await roomForStation(stationId);
    expect(occupancy.principalId).toBe(principalId);
    expect(occupancy.room, "the station's occupant has a room of its own").not.toBeNull();
    const [bound] = await db
      .select({ principalId: matrixRooms.principalId, stationId: matrixRooms.stationId })
      .from(matrixRooms)
      .where(eq(matrixRooms.roomId, occupancy.room!.roomId));
    expect(bound!.principalId).toBe(principalId);
    expect(bound!.stationId, "station_id is still populated — the deployed sweep joins on it").toBe(
      stationId
    );

    expect((outcome as { roomId: string }).roomId).toBe(occupancy.room!.roomId);
    expect(sent.every((s) => s.roomId === occupancy.room!.roomId)).toBe(true);
    expect(sent.every((s) => s.userId === bridgeUserId(HANDLE, DOMAIN))).toBe(true);
  });

  test("a homeserver that refuses leaves the assignment standing, and says so rather than reporting success", async () => {
    // The deliberate half of the decision, asserted as behaviour. Occupancy
    // is a fact in the organization plane; a room is its shadow on a system
    // this hub does not own, and assignment is a MOVE that has already
    // vacated wherever the principal was — so a rollback could not be
    // partial. What it must not do is read as success.
    onProvisionStation(async () => {
      throw new Error("homeserver unreachable");
    });

    const stationId = await adopt(`opencode:${RUN}-refused`);
    const principalId = await createAgent(`${HANDLE}-refused`);

    const assigned = await assign(stationId, principalId);
    expect(assigned.status).toBe(200);
    expect(assigned.body.room, "the failure is in the answer, not swallowed").toEqual({
      status: "failed",
      error: "homeserver unreachable",
    });

    const [row] = await db
      .select({ principalId: stations.principalId })
      .from(stations)
      .where(eq(stations.id, stationId));
    expect(row!.principalId, "the assignment stands — it is not undone by a homeserver").toBe(
      principalId
    );
    expect(
      (await roomForStation(stationId)).room,
      "and it is honest that there is no room yet"
    ).toBeNull();
  });

  test("a hub with no Matrix bridge reports that, rather than a fault", async () => {
    onProvisionStation(null);

    const stationId = await adopt(`opencode:${RUN}-nobridge`);
    const principalId = await createAgent(`${HANDLE}-nobridge`);

    const assigned = await assign(stationId, principalId);
    expect(assigned.status).toBe(200);
    expect(assigned.body.room).toEqual({ status: "no-bridge" });
    const [row] = await db
      .select({ principalId: stations.principalId })
      .from(stations)
      .where(eq(stations.id, stationId));
    expect(row!.principalId).toBe(principalId);
  });
});

describe("a harness-mode station is spoken for as the account it actually owns", () => {
  test("its gate is sent as the harness's own mxid, never as an @agent_ the bridge never registered", async () => {
    const hs = fakeHomeserver();
    onProvisionStation((id) => provisionStation(id, hs.deps));

    // A station that answers for itself: the node agent reports the mxid it
    // holds, and `station-registry` records it.
    const harnessMxid = `@molt-${RUN}:${DOMAIN}`;
    const stationId = await adopt(`opencode:${RUN}-harness`, { matrixId: harnessMxid });
    await db
      .update(stations)
      .set({ matrixIdentityMode: "harness" })
      .where(eq(stations.id, stationId));

    const principalId = await createAgent(`${HANDLE}-harness`);
    const assigned = await assign(stationId, principalId);
    expect(assigned.status).toBe(200);
    expect(assigned.body.room).toEqual({ status: "provisioned" });

    // `provision.ts` creates the room AS the harness account and never
    // registers a bridge user for it — that is the mode's whole point.
    expect(hs.ensuredRooms).toHaveLength(1);
    expect(hs.ensuredRooms[0]!.creator).toBe(harnessMxid);
    expect(hs.ensuredUsers, "no bridge identity is minted over an account somebody else holds").toEqual(
      []
    );

    const room = (await roomForStation(stationId)).room!;
    const cardId = `crd_${RUN}_harness`;
    await dispatched(stationId, cardId);
    const { deps, sent } = gateDeps();
    const outcome = await projectGate(
      BOOTSTRAP_TENANT_ID,
      delivery(`gate_${RUN}_harness`, cardId),
      deps
    );

    expect(outcome.status).toBe("sent");
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.every((s) => s.userId === harnessMxid),
      "sent as the account that created the room and is joined to it"
    ).toBe(true);
    expect(
      sent.some((s) => s.userId === bridgeUserId(`${HANDLE}-harness`, DOMAIN)),
      "never as the @agent_ nothing registered — the homeserver would refuse it"
    ).toBe(false);
    expect(room.roomId).toBe((outcome as { roomId: string }).roomId);
  });

  test("a harness-mode station that has reported no mxid gets its claim back rather than an undeliverable send", async () => {
    onProvisionStation(null);
    const stationId = await adopt(`opencode:${RUN}-mute`);
    await db
      .update(stations)
      .set({ matrixIdentityMode: "harness" })
      .where(eq(stations.id, stationId));

    // A room from before the station flipped modes, bound to its occupant —
    // the only way to reach "there is a room and an occupant, and still
    // nobody to speak as".
    const principalId = await createAgent(`${HANDLE}-mute`);
    await assign(stationId, principalId);
    await db.insert(matrixRooms).values({
      roomId: `!mute-${RUN}:${DOMAIN}`,
      tenantId: BOOTSTRAP_TENANT_ID,
      stationId,
      alias: `#mute-${RUN}:${DOMAIN}`,
      principalId,
    });

    const cardId = `crd_${RUN}_mute`;
    await dispatched(stationId, cardId);
    const { deps, sent } = gateDeps();
    const gateId = `gate_${RUN}_mute`;
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, delivery(gateId, cardId), deps);

    expect(outcome.status).toBe("no-speaker");
    expect(sent, "nothing was posted as an identity that could not deliver it").toEqual([]);
    const claims =
      await rawSql`SELECT gate_id FROM matrix_gate_events WHERE gate_id = ${gateId}`;
    expect(
      claims.length,
      "the claim is released, so the sweep can retry once the harness reports its mxid"
    ).toBe(0);
  });
});
