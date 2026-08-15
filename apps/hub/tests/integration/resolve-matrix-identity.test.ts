import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { adoptStations, listAdopted } from "../../src/services/station-registry";
import { linkIdentity } from "../../src/services/principal-identities";
import { resolveMatrixId } from "../../src/services/matrix-identity";

/**
 * Given a Matrix id, who is that?
 *
 * The question an Application Service bridge asks on every inbound event, and
 * the last piece of Phase 2 in the Organization layer plan. Both halves now
 * exist: `stations.matrix_id` for agents (populated 2026-08-15) and
 * `principal_identities` for people (#335).
 *
 * The answer has to distinguish them, because the two are treated differently
 * everywhere downstream: a human's approval must carry its sender or kaambaan's
 * separation-of-duties check is void, while an agent's message is work output.
 * A resolver that said only "known" would have thrown that distinction away at
 * the one point where it is cheap to keep.
 */

const USER = "test-user-mxresolve";
const AGENT_MXID = "@onboarding-olivia:id.agentpod.dev";
const CLASHER = "test-user-mxresolve-clash";
let nodeId = "";
let stationId = "";

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "mxresolve@example.com", name: "MX" });

  // Enrolled and adopted through the real services rather than hand-written
  // INSERTs. A fixture that writes its own rows has to guess the schema, and a
  // guess that is wrong fails as a column error five tests deep — which is
  // exactly what the first version of this file did.
  const { token } = await mintEnrollmentToken(USER);
  const enrolled = await enrollNode(token, {
    hostname: "mxresolve-host",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  nodeId = enrolled.nodeId;

  await adoptStations(USER, nodeId, ["hermes:olivia"], [
    {
      key: "hermes:olivia",
      harness: "hermes",
      kind: "leaf",
      displayName: "Olivia",
      parentKey: null,
      workspacePath: "/root/.hermes",
      capabilities: ["health"],
      matrixId: AGENT_MXID,
      adopted: false,
    },
  ]);

  stationId = (await listAdopted(USER, nodeId)).find((s) => s.stationKey === "hermes:olivia")!.id;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE node_id = ${nodeId}`;
    await rawSql`DELETE FROM nodes WHERE id = ${nodeId}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${USER}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("resolveMatrixId", () => {
  test("resolves an agent's mxid to its station", async () => {
    const found = await resolveMatrixId(AGENT_MXID);

    expect(found?.kind).toBe("station");
    if (found?.kind !== "station") throw new Error("unreachable");
    expect(found.stationId).toBe(stationId);
    expect(found.harness).toBe("hermes");
  });

  test("resolves a person's mxid to their principal", async () => {
    await linkIdentity(USER, "matrix", "@rakesh:id.agentpod.dev");

    const found = await resolveMatrixId("@rakesh:id.agentpod.dev");
    expect(found?.kind).toBe("principal");
    if (found?.kind !== "principal") throw new Error("unreachable");
    expect(found.principalId).toBe(USER);
  });

  test("answers null for an mxid nobody claims", async () => {
    // Most Matrix ids in a room belong to neither: other people's accounts,
    // bots, the server's own. Unknown is an ordinary answer and a bridge must
    // be able to ignore an event rather than fail on it.
    expect(await resolveMatrixId("@stranger:matrix.org")).toBeNull();
  });

  test("an id in another namespace does not answer for Matrix", async () => {
    // External ids are opaque per system. A kaambaan id shaped like an mxid
    // names the same person in a different namespace, which is not the same
    // claim — and must not resolve a Matrix sender.
    await linkIdentity(USER, "kaambaan", "@lookalike:id.agentpod.dev");

    expect(await resolveMatrixId("@lookalike:id.agentpod.dev")).toBeNull();
  });

  test("refuses to choose when a station and a principal claim one mxid", async () => {
    // Nothing prevents this: the two facts live in different tables with no
    // constraint spanning them, and they arrive from different places — one read
    // off a host by the node agent, one written by an operator. Silently
    // preferring either would attribute a human's approval to an agent, or an
    // agent's output to a human.
    await createTestUser({ id: CLASHER, email: "clash@example.com", name: "Clash" });
    await linkIdentity(CLASHER, "matrix", AGENT_MXID);

    const found = await resolveMatrixId(AGENT_MXID);

    // Deterministic: it must be ambiguous, not "whichever table was queried
    // first". An earlier version of this test accepted either answer, which
    // meant it could not fail for the reason it names.
    expect(found?.kind).toBe("ambiguous");
    if (found?.kind !== "ambiguous") throw new Error("unreachable");
    expect(found.stationId).toBe(stationId);
    expect(found.principalId).toBe(CLASHER);

    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${CLASHER}`;
    await rawSql`DELETE FROM "user" WHERE id = ${CLASHER}`;

    // And with the clash removed it resolves cleanly again.
    expect((await resolveMatrixId(AGENT_MXID))?.kind).toBe("station");
  });

  test("an empty or malformed id is unknown, not an error", async () => {
    expect(await resolveMatrixId("")).toBeNull();
    expect(await resolveMatrixId("not-an-mxid")).toBeNull();
  });
});
