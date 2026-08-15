import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { adoptStations, listAdopted } from "../../src/services/station-registry";
import { createSession } from "../../src/services/acp-sessions";
import { setGrant, deleteGrant } from "../../src/services/grants";

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
let nodeName = "";
let stationKey = "";
let stationId = "";

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
  // The grant names the node, so the test has to know what this fleet ended up
  // calling it — enrolment suffixes a hostname collision.
  nodeName = (await rawSql`SELECT name FROM nodes WHERE id = ${nodeId}`)[0]!.name as string;

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
});

afterEach(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  await deleteGrant(USER).catch(() => {});
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER}`;
    await rawSql`DELETE FROM stations WHERE node_id = ${nodeId}`;
    await rawSql`DELETE FROM nodes WHERE id = ${nodeId}`;
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
    await setGrant(USER, {
      mayDispatch: [`agentpod:${nodeName}/hermes:some-other-agent`],
      mayGrantReach: false,
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("refuses a grant written in another plane's namespace", async () => {
    // The decision's rule from this side: a kaambaan value is not this plane's
    // business, so it grants nothing here — while remaining a perfectly valid
    // grant over there.
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER, { mayDispatch: ["kaambaan:agt_anything"], mayGrantReach: false });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("refuses the retired formats rather than honouring them", async () => {
    // `hermes:*` was valid in CONTROL_PAIR_GRANTS, and `agentpod:hermes:*` was
    // valid before a grant named a node. Neither may still match: the first
    // would let a half-migrated deployment enforce two rules at once, and the
    // second cannot say WHICH node it meant, which is the over-grant that shape
    // exists to remove.
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER, {
      mayDispatch: ["hermes:*", "agentpod:hermes:*"],
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

    // With a grant, the SAME call gets past the control and fails on readiness
    // instead — which is what proves the refusal above came from the control
    // and not from the node being unreachable.
    await setGrant(USER, { mayDispatch: [`agentpod:${nodeName}/hermes:*`], mayGrantReach: false });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/offline|not ready|does not support/i);
  });

  test("a grant for the same station key on another node does not reach this one", async () => {
    // The defect that produced the node-qualified shape: station keys repeat
    // across nodes — `opencode:c52ddf65` exists on two in production — so a
    // permission for one host must not silently cover another.
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER, {
      mayDispatch: [`agentpod:some-other-host/${stationKey}`],
      mayGrantReach: false,
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("a node wildcard reaches it, because that says every node out loud", async () => {
    process.env.ENFORCE_CONTROL_PAIR = "true";
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/offline|not ready|does not support/i);
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
