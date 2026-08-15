import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { adoptStations, listAdopted } from "../../src/services/station-registry";
import { createSession } from "../../src/services/acp-sessions";

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
});

afterEach(() => {
  delete process.env.CONTROL_PAIR_GRANTS;
});

afterAll(async () => {
  delete process.env.CONTROL_PAIR_GRANTS;
  try {
    await rawSql`DELETE FROM stations WHERE node_id = ${nodeId}`;
    await rawSql`DELETE FROM nodes WHERE id = ${nodeId}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("dispatch consults the control pair (#Phase 3)", () => {
  test("refuses a principal with no grant, when grants are configured", async () => {
    process.env.CONTROL_PAIR_GRANTS = JSON.stringify({
      someone_else: { mayDispatch: ["hermes:*"], mayGrantReach: false },
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("refuses a grant that does not cover this station", async () => {
    process.env.CONTROL_PAIR_GRANTS = JSON.stringify({
      [USER]: { mayDispatch: ["hermes:some-other-agent"], mayGrantReach: false },
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });

  test("refuses BEFORE reporting on the station's readiness", async () => {
    // Ordering is the assertion. This node is offline, so an unguarded call
    // fails with "Node is offline." — a caller who was never permitted must not
    // learn that, because the difference between "offline" and "no permission"
    // tells them the station exists.
    process.env.CONTROL_PAIR_GRANTS = JSON.stringify({
      someone_else: { mayDispatch: ["hermes:*"], mayGrantReach: false },
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);

    // And with a grant, the SAME call gets past the control and fails on
    // readiness instead — which is what proves the refusal above came from the
    // control pair and not from the station being unreachable.
    process.env.CONTROL_PAIR_GRANTS = JSON.stringify({
      [USER]: { mayDispatch: ["hermes:*"], mayGrantReach: false },
    });

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/offline|not ready|does not support/i);
  });

  test("is not enforced when nothing is configured", async () => {
    // Unconfigured is off. The same call reaches the readiness gates, so a
    // standalone hub with no grants anywhere keeps working exactly as before.
    delete process.env.CONTROL_PAIR_GRANTS;

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/offline|not ready|does not support/i);
  });

  test("a broken configuration denies rather than disabling the control", async () => {
    // Losing the rules must never be the same thing as having none.
    process.env.CONTROL_PAIR_GRANTS = "{not json";

    await expect(
      createSession({ stationId, userId: USER, mode: "default" })
    ).rejects.toThrow(/permission/i);
  });
});
