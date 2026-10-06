process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { setOrgPlaneForTests, TEST_PLANE } from "../../auth/org-plane/config";
import { setPrincipalDirectoryForTests, type PrincipalDirectory } from "./directory";
import { OrgPlaneError, type PlanePrincipal } from "./client";
import {
  createPrincipal,
  humanPrincipalIdForUser,
  listPrincipals,
  principalById,
  principalForUser,
  principalHandle,
  SUSPENDED_AT_UNKNOWN,
} from "../principals";
import { getGrant, setGrant } from "../grants";
import { resolveMatrixId } from "../matrix-identity";
import { matrixIdForHuman } from "../human-matrix-ids";
import { rawSql } from "../../db/drizzle";

const HUMAN: PlanePrincipal = {
  id: "prn_0000000000000000000a",
  kind: "human",
  handle: "op",
  displayName: "Op",
  organizationId: null,
  suspended: false,
  grant: { mayDispatch: ["prn_0000000000000000000b"], mayGrantReach: true, scopes: [] },
};
const AGENT: PlanePrincipal = { ...HUMAN, id: "prn_0000000000000000000b", kind: "agent", handle: "cody", suspended: true, grant: null };

function dir(over: Partial<PrincipalDirectory> = {}): PrincipalDirectory {
  const all = new Map([HUMAN, AGENT].map((p) => [p.id, p]));
  return {
    principal: async (id) => all.get(id) ?? null,
    identity: async (system, ext) =>
      system === "matrix" && ext === "@op:id.test" ? { principalId: HUMAN.id, kind: "human", suspended: false } : null,
    list: async () => [...all.values()],
    invalidate: () => {},
    ...over,
  };
}

const restores: Array<() => void> = [];
beforeAll(ensurePgMigrations);
afterEach(() => restores.splice(0).reverse().forEach((r) => r()));
function plane(d = dir()) {
  restores.push(setOrgPlaneForTests(TEST_PLANE), setPrincipalDirectoryForTests(d));
}

describe("principal reads from the plane", () => {
  test("principalById maps the plane's principal; suspended reads as a truthy suspendedAt", async () => {
    plane();
    // The plane's principal read carries no email; nothing under the plane needs it.
    expect(await principalById(HUMAN.id)).toEqual({ id: HUMAN.id, kind: "human", suspendedAt: null, email: null, emailVerified: null });
    expect((await principalById(AGENT.id))?.suspendedAt).toBe(SUSPENDED_AT_UNKNOWN);
  });

  test("principalForUser: an AuthUser.id is a prn_, and only a human answers", async () => {
    plane();
    expect((await principalForUser(HUMAN.id))?.id).toBe(HUMAN.id);
    expect(await principalForUser(AGENT.id)).toBeNull();
  });

  test("principalHandle and getGrant read the plane's principal", async () => {
    plane();
    expect(await principalHandle(AGENT.id)).toBe("cody");
    expect(await getGrant(HUMAN.id)).toEqual(HUMAN.grant);
    expect(await getGrant(AGENT.id)).toBeNull();
  });

  test("listPrincipals reads the plane's workspace, a human's userId being its own prn_", async () => {
    plane();
    const rows = await listPrincipals();
    expect(rows.find((r) => r.id === HUMAN.id)).toEqual({
      id: HUMAN.id, kind: "human", handle: "op", displayName: "Op", userId: HUMAN.id, suspendedAt: null,
    });
    expect(rows.find((r) => r.id === AGENT.id)?.suspendedAt).toBe(SUSPENDED_AT_UNKNOWN);
    expect(rows.find((r) => r.id === AGENT.id)?.userId).toBeNull();
  });

  test("humanPrincipalIdForUser is the identity under the plane", async () => {
    plane();
    expect(await humanPrincipalIdForUser(HUMAN.id)).toBe(HUMAN.id);
    expect(await humanPrincipalIdForUser("8b0c2f6e-1c1d-4e3a-9a57-0d6f3c2b1a90")).toBeNull();
  });

  test("writes the plane owns are refused locally, and a grant write goes to the plane", async () => {
    plane();
    await expect(createPrincipal({ kind: "human", handle: "nope" })).rejects.toThrow(/org plane/);
    // setGrant goes to the plane (Task 11 relies on it).
    const { setOrgPlaneClientForTests } = await import("./client");
    const put: unknown[] = [];
    restores.push(
      setOrgPlaneClientForTests({ putGrant: async (id: string, g: unknown) => void put.push({ id, g }) } as never),
    );
    await setGrant(AGENT.id, { mayDispatch: [], mayGrantReach: false });
    expect(put).toEqual([{ id: AGENT.id, g: { mayDispatch: [], mayGrantReach: false, scopes: [] } }]);
  });

  test("setGrant with no scopes keeps the plane's current scopes (PUT replaces)", async () => {
    plane(dir({ principal: async (id) => (id === HUMAN.id ? { ...HUMAN, grant: { ...HUMAN.grant!, scopes: ["evidence:read"] } } : null) }));
    const { setOrgPlaneClientForTests } = await import("./client");
    const put: unknown[] = [];
    restores.push(setOrgPlaneClientForTests({ putGrant: async (_id: string, g: unknown) => void put.push(g) } as never));
    await setGrant(HUMAN.id, { mayDispatch: [], mayGrantReach: true });
    expect(put).toEqual([{ mayDispatch: [], mayGrantReach: true, scopes: ["evidence:read"] }]);
  });
});

describe("Matrix sender, resolved at the plane", () => {
  test("a linked sender resolves through GET /api/identities/matrix/:mxid, and a person's Matrix id is remembered", async () => {
    plane();
    await rawSql`DELETE FROM human_matrix_ids WHERE principal_id = ${HUMAN.id}`;
    expect(await resolveMatrixId("@op:id.test")).toEqual({ kind: "principal", principalId: HUMAN.id });
    // The hub keeps the other direction itself (the plane has no read for it): whom to invite.
    expect(await matrixIdForHuman(HUMAN.id)).toBe("@op:id.test");
    await rawSql`DELETE FROM human_matrix_ids WHERE principal_id = ${HUMAN.id}`;
  });

  test("an agent sender is not remembered as a person", async () => {
    plane(dir({ identity: async () => ({ principalId: AGENT.id, kind: "agent", suspended: false }) }));
    await rawSql`DELETE FROM human_matrix_ids WHERE principal_id = ${AGENT.id}`;
    expect(await resolveMatrixId("@agent_cody:id.test")).toEqual({ kind: "principal", principalId: AGENT.id });
    expect(await matrixIdForHuman(AGENT.id)).toBeNull();
  });

  test("an unlinked sender is null", async () => {
    plane();
    expect(await resolveMatrixId("@stranger:id.test")).toBeNull();
  });

  test("a plane outage with nothing cached throws OrgPlaneError rather than reading as 'unlinked'", async () => {
    plane(dir({ identity: async () => { throw new OrgPlaneError(0, "unreachable"); } }));
    await expect(resolveMatrixId("@op:id.test")).rejects.toBeInstanceOf(OrgPlaneError);
  });
});
