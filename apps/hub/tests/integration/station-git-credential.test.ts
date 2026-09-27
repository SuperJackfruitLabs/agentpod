import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { stationGitCredentials } from "../../src/db/schema/git-credentials";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { enrollNode, mintEnrollmentToken } from "../../src/services/enrollment";
import { stations } from "../../src/db/schema/stations";
import { createStationGitCredentialRoutes } from "../../src/routes/station-git-credential";
import {
  provisionStationGitCredential,
  readStationGitCredential,
  revokeStationGitCredential,
  tokenNameFor,
} from "../../src/services/station-git-credential";
import type { ForgeConfig } from "../../src/services/forge";

/**
 * The credential a station's agent writes with.
 *
 * What is asserted hardest here is what the route REFUSES. A node that can read another node's
 * station credential is the whole failure, and it is not visible from the happy path.
 */
const RUN = crypto.randomUUID().slice(0, 8);
const cfg: ForgeConfig = { baseUrl: "https://forge.test", adminToken: "admin" };

const TEST_USER = `usr_gitcred_${RUN}`;
const STATION_A = `st_gitcred_a_${RUN}`;
const STATION_B = `st_gitcred_b_${RUN}`;

// Enrolled rather than hand-inserted: `nodes` carries NOT NULL columns a hand-written INSERT
// silently gets wrong, and enrolling is the path production takes to produce a node secret.
let NODE_A = "";
let NODE_B = "";
let SECRET_A = "";
let SECRET_B = "";

const app = new Hono().route("/api", createStationGitCredentialRoutes());

/** A forge that answers every call as though the account and token were real. */
function forgeStub() {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace(cfg.baseUrl, "")}`);
    if (url.endsWith("/tokens") && init?.method === "POST") {
      // Echoes the requested name, as forge does. A stub that invents one hides the fact that the
      // stored `token_name` is the handle revocation later needs.
      const asked = init?.body ? (JSON.parse(String(init.body)) as { name?: string }).name : undefined;
      return new Response(
        JSON.stringify({ id: 1, name: asked ?? "unnamed", sha1: "t".repeat(40) }),
        { status: 201 },
      );
    }
    if (url.includes("/users/") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ id: 3, login: "coder-kai", email: "x@y" }), { status: 200 });
    }
    return new Response("{}", { status: 204 });
  };
  return { fetchImpl, calls };
}

async function enroll(hostname: string) {
  const { token } = await mintEnrollmentToken(TEST_USER);
  return enrollNode(token, { hostname, os: "linux", arch: "amd64", cpuCount: 2 });
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: `station-git-credential-${RUN}@example.com`,
    name: "Station Git Credential Test User",
  });

  ({ nodeId: NODE_A, nodeSecret: SECRET_A } = await enroll(`gitcred-a-${RUN}`));
  ({ nodeId: NODE_B, nodeSecret: SECRET_B } = await enroll(`gitcred-b-${RUN}`));

  for (const [id, nodeId] of [[STATION_A, NODE_A], [STATION_B, NODE_B]] as const) {
    await db.insert(stations).values({
      id,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId: TEST_USER,
      nodeId,
      harness: "hermes",
      stationKey: `hermes:${id}`,
      kind: "leaf",
      displayName: id,
      workspacePath: "/tmp/ws",
    });
  }
});

afterAll(async () => {
  await rawSql`DELETE FROM station_git_credentials WHERE station_id IN (${STATION_A}, ${STATION_B})`;
  await rawSql`DELETE FROM stations WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM nodes WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
});

function redeem(nodeId: string, stationId: string, bearer: string) {
  return app.request(`/api/nodes/${nodeId}/stations/${stationId}/git-credential`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

describe("provisioning", () => {
  test("stores the token encrypted, never in the clear", async () => {
    const { fetchImpl } = forgeStub();
    await provisionStationGitCredential(
      cfg,
      { stationId: STATION_A, tenantId: BOOTSTRAP_TENANT_ID, username: "coder-kai", repositories: ["o/r"] },
      fetchImpl,
    );

    const [row] = await db
      .select()
      .from(stationGitCredentials)
      .where(eq(stationGitCredentials.stationId, STATION_A));

    expect(row).toBeDefined();
    // The token is `t`×40. Its absence from the stored column is the whole point of the column's
    // name, and a plaintext write would still satisfy every other assertion in this file.
    expect(row!.tokenEncrypted).not.toContain("t".repeat(40));
    expect(row!.tokenName).toBe(tokenNameFor(STATION_A));
    expect(row!.username).toBe("coder-kai");

    // It round-trips, so the encryption is real rather than merely lossy.
    const read = await readStationGitCredential(STATION_A);
    expect(read?.token).toBe("t".repeat(40));
  });

  test("re-provisioning revokes the old token before minting, so none is stranded", async () => {
    const { fetchImpl, calls } = forgeStub();
    await provisionStationGitCredential(
      cfg,
      { stationId: STATION_A, tenantId: BOOTSTRAP_TENANT_ID, username: "coder-kai" },
      fetchImpl,
    );
    const revokeAt = calls.findIndex((c) => c.startsWith("DELETE"));
    const mintAt = calls.findIndex((c) => c.startsWith("POST") && c.endsWith("/tokens"));
    expect(revokeAt).toBeGreaterThanOrEqual(0);
    // forge will not show a token twice, so a token this row stops pointing at cannot be found by
    // name afterwards — revoking second would strand a live credential permanently.
    expect(revokeAt).toBeLessThan(mintAt);
  });
});

describe("redeeming", () => {
  test("a node gets its own station's credential", async () => {
    const res = await redeem(NODE_A, STATION_A, `${NODE_A}:${SECRET_A}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { username: string; token: string };
    expect(body.username).toBe("coder-kai");
    expect(body.token).toBe("t".repeat(40));
  });

  test("it is repeatable, because git asks on every operation", async () => {
    // The difference from the Matrix credential, which is single-use. A second call refusing here
    // would authorise the first `git push` of a turn and refuse the second.
    expect((await redeem(NODE_A, STATION_A, `${NODE_A}:${SECRET_A}`)).status).toBe(200);
    expect((await redeem(NODE_A, STATION_A, `${NODE_A}:${SECRET_A}`)).status).toBe(200);
  });

  test("another node's station is refused exactly like one that does not exist", async () => {
    // Both 403, and identically: a difference here lets a node discover which station ids exist on
    // its neighbours by reading 403 apart from 404.
    const foreign = await redeem(NODE_B, STATION_A, `${NODE_B}:${SECRET_B}`);
    const absent = await redeem(NODE_B, `station_does_not_exist_${RUN}`, `${NODE_B}:${SECRET_B}`);

    expect(foreign.status).toBe(403);
    expect(absent.status).toBe(403);
    expect(await foreign.text()).toBe(await absent.text());
  });

  test("a credential for a different node than the path names is refused like a wrong secret", async () => {
    const res = await redeem(NODE_A, STATION_A, `${NODE_B}:${SECRET_B}`);
    expect(res.status).toBe(401);
  });

  test("a wrong secret is refused", async () => {
    const res = await redeem(NODE_A, STATION_A, `${NODE_A}:not-the-secret`);
    expect(res.status).toBe(401);
  });

  test("a station with no git identity says so distinctly, so a node stops asking", async () => {
    const res = await redeem(NODE_B, STATION_B, `${NODE_B}:${SECRET_B}`);
    expect(res.status).toBe(409);
  });
});

describe("revoking", () => {
  test("revokes on forge before deleting the row", async () => {
    const { fetchImpl, calls } = forgeStub();
    const removed = await revokeStationGitCredential(cfg, STATION_A, fetchImpl);
    expect(removed).toBe(true);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(true);
    expect(await readStationGitCredential(STATION_A)).toBeNull();
  });

  test("revoking a station that has none is not an error", async () => {
    const { fetchImpl } = forgeStub();
    expect(await revokeStationGitCredential(cfg, STATION_B, fetchImpl)).toBe(false);
  });
});
