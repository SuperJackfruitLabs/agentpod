import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { setGrant } from "../../src/services/grants";
import { createPrincipal } from "../../src/services/principals";
import { stationWriteRoutes } from "../../src/routes/station-writes";

/**
 * Writing into an agent's workspace is granting it reach.
 *
 * One request writes `~/.claude/settings.json` or an `.env`. That is the act
 * `mayGrantReach` exists to govern, and until this file existed the dispatch
 * check was guarding the front door of a building with no walls: refuse someone
 * an agent, and they write credentials into one they are allowed to dispatch.
 */

const USER = "test-user-writes-reach";
const NODE = "node_writes_reach";
const STATION = "station_writes_reach";

let USER_PRINCIPAL: string;
/** The agent occupying STATION — the matcher compares a grant against this now. */
let AGENT_PRINCIPAL: string;
/** Some other agent, granted where a test wants to prove the scope check is real. */
const OTHER_AGENT = "prn_ffffffffffffffffffff";

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: USER, role: "user" });
    await next();
  });
  a.route("/", stationWriteRoutes);
  return a;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "writes-reach@example.com", name: "WR" });
  USER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "writes-reach-it-user", userId: USER });
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: "writes-reach-it-agent" });
  const tenant = await resolveTenantForUser(USER);
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${USER}, 'writes-box', 'writes-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${USER}, ${NODE}, 'hermes', 'hermes:writes', 'leaf', 'Writes',
            '["fs.write"]'::jsonb, ${AGENT_PRINCIPAL}, now(), now())`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM station_audit WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER_PRINCIPAL}`;
    await rawSql`DELETE FROM principal_identities WHERE external_id = ${USER}`;
    await rawSql`DELETE FROM principals WHERE handle IN ('writes-reach-it-user', 'writes-reach-it-agent')`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

const MUTATIONS: Array<[string, Record<string, unknown>]> = [
  ["fs/write", { path: "a.txt", content: "x", encoding: "utf8" }],
  ["fs/mkdir", { path: "d" }],
  ["fs/move", { from: "a.txt", to: "b.txt" }],
  ["fs/delete", { path: "a.txt" }],
];

function post(path: string, body: Record<string, unknown>) {
  return app().request(`/stations/${STATION}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("fs mutations require reach", () => {
  for (const [path, body] of MUTATIONS) {
    test(`${path} is refused without mayGrantReach`, async () => {
      // In scope, no reach: exactly the principal this control exists for.
      await setGrant(USER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

      const res = await post(path, body);

      // 403, not 502: this is a decision, not an upstream failure (#342).
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/permission to change this agent/i);
    });
  }

  test("is refused when reach is held but the station is out of scope", async () => {
    await setGrant(USER_PRINCIPAL, { mayDispatch: [OTHER_AGENT], mayGrantReach: true });
    expect((await post("fs/write", { path: "a.txt", content: "x", encoding: "utf8" })).status).toBe(403);
  });

  test("a refusal is audited, not only logged", async () => {
    // An attempt refused and recorded nowhere is indistinguishable from an
    // attempt nobody made — which is what an operator is trying to tell apart.
    await rawSql`DELETE FROM station_audit WHERE user_id = ${USER}`;
    await setGrant(USER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await post("fs/write", { path: "a.txt", content: "x", encoding: "utf8" });

    const rows = await rawSql`
      SELECT verb, result FROM station_audit WHERE user_id = ${USER} AND verb = 'fs.write'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.result).toBe("error");
  });

  test("the capability gate still answers first, because the two refusals mean different things", async () => {
    // "This station cannot" and "you may not" send an operator to different
    // places. Reordering these would send them to the wrong one.
    await setGrant(USER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });
    await rawSql`UPDATE stations SET capabilities = '[]'::jsonb WHERE id = ${STATION}`;

    const res = await post("fs/write", { path: "a.txt", content: "x", encoding: "utf8" });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/does not advertise/i);

    await rawSql`UPDATE stations SET capabilities = '["fs.write"]'::jsonb WHERE id = ${STATION}`;
  });

  test("a principal with reach in scope gets past the gate", async () => {
    // Past the gate is as far as this suite goes: there is no live node, so the
    // broker answers "node offline" (409). What matters is that it is not 403.
    await setGrant(USER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: true });

    const res = await post("fs/write", { path: "a.txt", content: "x", encoding: "utf8" });
    expect(res.status).not.toBe(403);
  });
});
