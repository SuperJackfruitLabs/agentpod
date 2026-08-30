import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { adoptStations, listAdopted } from "../../src/services/station-registry";
import { Hono } from "hono";
import { createSession } from "../../src/services/acp-sessions";
import { stationAcpRoutes } from "../../src/routes/station-acp";
import { setGrant, deleteGrant } from "../../src/services/grants";
import { createPrincipal } from "../../src/services/principals";

/**
 * The control pair, enforced where dispatch actually happens.
 *
 * The unit tests cover the policy; this covers the thing that matters — that
 * `createSession` consults it. A policy function nobody calls is the failure
 * this repo has met before: an `acp` capability advertised because a binary
 * resolved, a posture scanner grading machines it never opened.
 *
 * `createSession` is the one choke point BOTH dispatch paths pass through: the
 * console/API route (`routes/station-acp.ts`) and the kaambaan bridge
 * (`services/bridge/dispatch.ts`). Decision 4 of the ecosystem-identity decision
 * is explicit that a check covering only board-driven work leaves the most
 * common path — provisioning straight at AgentPod — unguarded, and "a control
 * with a hole that shape is not a control".
 */

const USER = "test-user-controlpair";
let nodeId = "";
let stationKey = "";
let stationId = "";

let USER_PRINCIPAL: string;
/** The agent occupying `stationId` — the matcher compares a grant against this now. */
let AGENT_PRINCIPAL: string;

// A second node, adopting a station with the SAME key, occupied by a
// DIFFERENT agent — the shape that made a bare station key unsafe to grant on
// (`opencode:c52ddf65` exists on two nodes in production). Proves the new,
// principal-keyed matcher still tells the two apart, the same way the old
// node-qualified pattern did.
const OTHER_NODE = "node_controlpair_other";
let otherStationId = "";
let OTHER_AGENT_PRINCIPAL: string;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "controlpair@example.com", name: "CP" });

  const { token } = await mintEnrollmentToken(USER);
  const enrolled = await enrollNode(token, {
    hostname: "controlpair-host",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  nodeId = enrolled.nodeId;

  stationKey = "hermes:cp-agent";
  await adoptStations(USER, nodeId, [stationKey], [
    {
      key: stationKey,
      harness: "hermes",
      kind: "leaf",
      displayName: "CP Agent",
      parentKey: null,
      workspacePath: "/root/.hermes",
      capabilities: ["health", "acp"],
      adopted: false,
    },
  ]);
  stationId = (await listAdopted(USER, nodeId)).find((s) => s.stationKey === stationKey)!.id;

  USER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "controlpair-it-user", userId: USER });
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: "controlpair-it-agent" });
  await rawSql`UPDATE stations SET principal_id = ${AGENT_PRINCIPAL} WHERE id = ${stationId}`;

  OTHER_AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: "controlpair-it-other-agent" });
  const tenant = (await rawSql`SELECT tenant_id FROM nodes WHERE id = ${nodeId}`)[0]!.tenant_id as string;
  await rawSql`DELETE FROM nodes WHERE id = ${OTHER_NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${OTHER_NODE}, ${tenant}, ${USER}, 'controlpair-other-box', 'controlpair-other-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await adoptStations(USER, OTHER_NODE, [stationKey], [
    {
      key: stationKey,
      harness: "hermes",
      kind: "leaf",
      displayName: "CP Agent (other node)",
      parentKey: null,
      workspacePath: "/root/.hermes",
      capabilities: ["health", "acp"],
      adopted: false,
    },
  ]);
  otherStationId = (await listAdopted(USER, OTHER_NODE)).find((s) => s.stationKey === stationKey)!.id;
  await rawSql`UPDATE stations SET principal_id = ${OTHER_AGENT_PRINCIPAL} WHERE id = ${otherStationId}`;
});

afterEach(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  await deleteGrant(USER_PRINCIPAL).catch(() => {});
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER_PRINCIPAL}`;
    await rawSql`DELETE FROM principal_identities WHERE external_id = ${USER}`;
    await rawSql`DELETE FROM stations WHERE node_id IN (${nodeId}, ${OTHER_NODE})`;
    await rawSql`DELETE FROM nodes WHERE id IN (${nodeId}, ${OTHER_NODE})`;
    await rawSql`DELETE FROM principals WHERE handle IN ('controlpair-it-user', 'controlpair-it-agent', 'controlpair-it-other-agent')`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("dispatch consults the control pair (#Phase 3)", () => {
  test("refuses a principal with no grant at all", async () => {
    // Absence is not permission. A principal nobody has granted anything is
    // refused, not waved through because no rule mentions them.
    process.env.ENFORCE_CONTROL_PAIR = "true";

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("refuses a grant that does not cover this station", async () => {
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER_PRINCIPAL, {
      mayDispatch: ["prn_ffffffffffffffffffff"],
      mayGrantReach: false,
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("refuses a value that is not a principal id, rather than treating it as one", async () => {
    // Namespacing is gone along with the pattern language: a value that is not
    // this station's occupant is refused the same way whatever it looks like,
    // whether it is shaped like the retired kaambaan namespace or anything else.
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER_PRINCIPAL, { mayDispatch: ["kaambaan:agt_anything"], mayGrantReach: false });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("refuses the retired formats rather than honouring them", async () => {
    // `hermes:*` was valid in CONTROL_PAIR_GRANTS, `agentpod:hermes:*` was valid
    // before a grant named a node, and `agentpod:*/hermes:*` was the node-
    // qualified form itself. None of the three may still match: a grant is now
    // an enumeration of principal ids, and none of these is one.
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER_PRINCIPAL, {
      mayDispatch: ["hermes:*", "agentpod:hermes:*", "agentpod:*/hermes:*"],
      mayGrantReach: false,
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("refuses BEFORE reporting on the station's readiness", async () => {
    // Ordering is the assertion. This node is offline, so an unguarded call
    // fails with "Node is offline." — a caller who was never permitted must not
    // learn that, because the difference tells them the station exists.
    process.env.ENFORCE_CONTROL_PAIR = "true";

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);

    // With a grant naming the station's actual occupant, the SAME call gets
    // past the control and fails on readiness instead — which is what proves
    // the refusal above came from the control and not from the node being
    // unreachable.
    await setGrant(USER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/offline|not ready|does not support/i);
  });

  test("a grant for another node's occupant of the same station key does not reach this one", async () => {
    // The defect that produced the retired node-qualified shape: station keys
    // repeat across nodes — `opencode:c52ddf65` exists on two in production —
    // so a permission for one host's agent must not silently cover another
    // host's agent, even one sitting at the identical key. The new matcher
    // gets this for free from equality: the two are different principal ids.
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER_PRINCIPAL, {
      mayDispatch: [OTHER_AGENT_PRINCIPAL],
      mayGrantReach: false,
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("a wildcard no longer reaches anything, however it is written", async () => {
    // BEHAVIOUR CHANGE from the retired scheme: `agentpod:*/hermes:*` used to
    // be the explicit, opt-in way to say "every node, said out loud", and this
    // test used to assert exactly that it got through. Decision
    // 2026-08-30-an-agent-is-a-principal.md §3 deletes wildcards rather than
    // narrowing them — there is no way left to express "every agent" in a
    // grant, so this now refuses like any other non-matching value.
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER_PRINCIPAL, { mayDispatch: ["*", "prn_*"], mayGrantReach: false });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("is not enforced when the switch is off, whatever the grants say", async () => {
    // An explicit switch rather than "are there any grants": those differ in
    // exactly the dangerous case, where a deployment MEANT to enforce and whose
    // grants failed to load would silently enforce nothing.
    delete process.env.ENFORCE_CONTROL_PAIR;

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/offline|not ready|does not support/i);
  });
});

describe("the route reports a denial as a refusal, not a gateway failure", () => {
  test("403, because 502 says the node failed and invites a retry", async () => {
    // Observed in production before this: a permission refusal came back as
    // 502. A caller cannot tell "you may not" from "the upstream broke", and
    // will retry something that can never succeed — an authorization decision
    // hidden behind an infrastructure one.
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await deleteGrant(USER_PRINCIPAL).catch(() => {});

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { id: USER });
      await next();
    });
    app.route("/api", stationAcpRoutes); // mounted at /api, as in index.ts

    const res = await app.request(`/api/stations/${stationId}/acp/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "ask" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission/i);
  });
});
