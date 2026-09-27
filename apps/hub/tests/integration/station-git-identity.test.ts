import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { stationGitIdentities } from "../../src/db/schema/git-identities";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { enrollNode, mintEnrollmentToken } from "../../src/services/enrollment";
import { createPrincipal } from "../../src/services/principals";
import { createStationGitIdentityRoutes } from "../../src/routes/station-git-identity";
import { revokeStationGitIdentity, keyTitleFor } from "../../src/services/station-git-identity";
import type { ForgeConfig } from "../../src/services/forge";

/**
 * The key a station pushes with.
 *
 * What is asserted hardest is what the route refuses, and what it never carries. A node that can
 * register a key against another agent's account can push as that agent, and neither failure is
 * visible from the happy path.
 */
const RUN = crypto.randomUUID().slice(0, 8);
const cfg: ForgeConfig = { baseUrl: "https://forge.test", adminToken: "admin" };

const TEST_USER = `usr_gitid_${RUN}`;
const STATION_A = `st_gitid_a_${RUN}`;
const STATION_B = `st_gitid_b_${RUN}`;
const HANDLE_A = `coder-kai-${RUN}`;

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPqRVGcqJWmS1Wc4o9xY3n5m6z8dKQfQfQfQfQfQfQfQ station-a";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbB station-b";

let NODE_A = "";
let NODE_B = "";
let SECRET_A = "";
let SECRET_B = "";

/** A forge that answers as though the account existed and keys register cleanly. */
function forgeStub(startId = 100) {
  const calls: string[] = [];
  let nextId = startId;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.replace(cfg.baseUrl, "")}`);
    if (url.endsWith("/keys") && method === "POST") {
      const asked = init?.body ? (JSON.parse(String(init.body)) as { title?: string }).title : undefined;
      return new Response(JSON.stringify({ id: nextId++, title: asked ?? "" }), { status: 201 });
    }
    if (url.includes("/users/") && method === "GET") {
      return new Response(JSON.stringify({ id: 3, login: HANDLE_A, email: "x@y" }), { status: 200 });
    }
    return new Response("{}", { status: 204 });
  };
  return { fetchImpl, calls };
}

const routeStub = forgeStub();
const app = new Hono().route(
  "/api",
  createStationGitIdentityRoutes({ forge: cfg, fetchImpl: routeStub.fetchImpl }),
);

async function enroll(hostname: string) {
  const { token } = await mintEnrollmentToken(TEST_USER);
  return enrollNode(token, { hostname, os: "linux", arch: "amd64", cpuCount: 2 });
}

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM principals WHERE handle = ${HANDLE_A}`;
  await createTestUser({
    id: TEST_USER,
    email: `station-git-identity-${RUN}@example.com`,
    name: "Station Git Identity Test User",
  });

  ({ nodeId: NODE_A, nodeSecret: SECRET_A } = await enroll(`gitid-a-${RUN}`));
  ({ nodeId: NODE_B, nodeSecret: SECRET_B } = await enroll(`gitid-b-${RUN}`));

  // createPrincipal returns the id itself, not a row.
  const principalId = await createPrincipal({ kind: "agent", handle: HANDLE_A });

  // STATION_A has an occupying agent; STATION_B deliberately has none.
  await db.insert(stations).values({
    id: STATION_A, tenantId: BOOTSTRAP_TENANT_ID, userId: TEST_USER, nodeId: NODE_A,
    harness: "hermes", stationKey: `hermes:${STATION_A}`, kind: "leaf",
    displayName: STATION_A, workspacePath: "/tmp/ws", principalId,
  });
  await db.insert(stations).values({
    id: STATION_B, tenantId: BOOTSTRAP_TENANT_ID, userId: TEST_USER, nodeId: NODE_B,
    harness: "hermes", stationKey: `hermes:${STATION_B}`, kind: "leaf",
    displayName: STATION_B, workspacePath: "/tmp/ws",
  });
});

afterAll(async () => {
  await rawSql`DELETE FROM station_git_identities WHERE station_id IN (${STATION_A}, ${STATION_B})`;
  await rawSql`DELETE FROM stations WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM nodes WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM principals WHERE handle = ${HANDLE_A}`;
});

function register(nodeId: string, stationId: string, bearer: string, body: unknown) {
  return app.request(`/api/nodes/${nodeId}/stations/${stationId}/git-identity`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("registering", () => {
  test("stores the key id, which is the only handle revocation has", async () => {
    const res = await register(NODE_A, STATION_A, `${NODE_A}:${SECRET_A}`, { publicKey: KEY_A });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { username: string; keyId: number; rotated: boolean };

    // Derived from the station's principal, never from the request.
    expect(body.username).toBe(HANDLE_A);
    expect(body.rotated).toBe(false);

    const [row] = await db
      .select()
      .from(stationGitIdentities)
      .where(eq(stationGitIdentities.stationId, STATION_A));
    expect(row!.keyId).toBe(body.keyId);
    expect(row!.publicKey).toBe(KEY_A);
    expect(row!.username).toBe(HANDLE_A);
  });

  test("no secret is stored, because the hub never receives one", async () => {
    const [row] = await db
      .select()
      .from(stationGitIdentities)
      .where(eq(stationGitIdentities.stationId, STATION_A));
    // The whole design in one assertion: every column is public information.
    expect(Object.keys(row!).some((k) => /token|secret|private/i.test(k))).toBe(false);
  });

  test("re-registering rotates: the old key is deleted before the new one is added", async () => {
    const res = await register(NODE_A, STATION_A, `${NODE_A}:${SECRET_A}`, { publicKey: KEY_B });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rotated: boolean };
    expect(body.rotated).toBe(true);

    const [row] = await db
      .select()
      .from(stationGitIdentities)
      .where(eq(stationGitIdentities.stationId, STATION_A));
    expect(row!.publicKey).toBe(KEY_B);
    expect(row!.rotatedAt).not.toBeNull();
  });

  test("a key that is not an OpenSSH public key is refused before forge sees it", async () => {
    // So a typo fails here, naming the field, rather than as an opaque refusal from forge.
    const res = await register(NODE_A, STATION_A, `${NODE_A}:${SECRET_A}`, { publicKey: "hunter2" });
    expect(res.status).toBe(400);
  });
});

describe("refusals", () => {
  test("another node's station is refused exactly like one that does not exist", async () => {
    const foreign = await register(NODE_B, STATION_A, `${NODE_B}:${SECRET_B}`, { publicKey: KEY_A });
    const absent = await register(NODE_B, `st_missing_${RUN}`, `${NODE_B}:${SECRET_B}`, { publicKey: KEY_A });
    expect(foreign.status).toBe(403);
    expect(absent.status).toBe(403);
    // Identical bodies, not merely identical statuses: a difference lets a node discover which
    // station ids exist on its neighbours.
    expect(await foreign.text()).toBe(await absent.text());
  });

  test("a credential for a different node than the path names is refused like a wrong secret", async () => {
    const res = await register(NODE_A, STATION_A, `${NODE_B}:${SECRET_B}`, { publicKey: KEY_A });
    expect(res.status).toBe(401);
  });

  test("a wrong secret is refused", async () => {
    const res = await register(NODE_A, STATION_A, `${NODE_A}:nope`, { publicKey: KEY_A });
    expect(res.status).toBe(401);
  });

  test("a station with no occupying agent has no account to register against", async () => {
    const res = await register(NODE_B, STATION_B, `${NODE_B}:${SECRET_B}`, { publicKey: KEY_A });
    expect(res.status).toBe(409);
  });

  test("a hub with no forge credential says so rather than failing inside a call", async () => {
    const off = new Hono().route("/api", createStationGitIdentityRoutes({ forge: null }));
    const res = await off.request(`/api/nodes/${NODE_A}/stations/${STATION_A}/git-identity`, {
      method: "POST",
      headers: { Authorization: `Bearer ${NODE_A}:${SECRET_A}`, "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: KEY_A }),
    });
    expect(res.status).toBe(503);
  });
});

describe("revoking", () => {
  test("deletes the key on forge before dropping the row", async () => {
    const { fetchImpl, calls } = forgeStub();
    expect(await revokeStationGitIdentity(cfg, STATION_A, fetchImpl)).toBe(true);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(true);
    const rows = await db
      .select()
      .from(stationGitIdentities)
      .where(eq(stationGitIdentities.stationId, STATION_A));
    expect(rows).toHaveLength(0);
  });

  test("a station with no identity is not an error", async () => {
    const { fetchImpl } = forgeStub();
    expect(await revokeStationGitIdentity(cfg, STATION_B, fetchImpl)).toBe(false);
  });

  test("the key title names the station, so an operator can prune an account", async () => {
    expect(keyTitleFor("st_x")).toBe("station-st_x");
  });
});
