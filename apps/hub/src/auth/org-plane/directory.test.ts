import { describe, expect, test } from "bun:test";
import { createPrincipalDirectory } from "./directory";
import { OrgPlaneError, type PlanePrincipal } from "./client";

const P: PlanePrincipal = {
  id: "prn_aaaaaaaaaaaaaaaaaaaa",
  kind: "agent",
  handle: "cody",
  displayName: "Cody",
  organizationId: "org_00000000000000000000",
  suspended: false,
  grant: { mayDispatch: [], mayGrantReach: false, scopes: [] },
};

function setup() {
  const state = { down: false, calls: 0, status: 0 };
  let now = 1_000_000;
  const client = () => ({
    getPrincipal: async (id: string) => {
      state.calls++;
      if (state.down) throw new OrgPlaneError(state.status, "unreachable");
      return id === P.id ? P : null;
    },
    lookupIdentity: async () => {
      state.calls++;
      if (state.down) throw new OrgPlaneError(state.status, "unreachable");
      return { principalId: P.id, kind: "agent" as const, suspended: false };
    },
    identitiesOf: async (id: string, system: string) => {
      state.calls++;
      if (state.down) throw new OrgPlaneError(state.status, "unreachable");
      return id === P.id ? [{ system, externalId: "@agent_cody:id.test" }] : null;
    },
    listPrincipals: async (kind: string) => {
      state.calls++;
      return kind === P.kind ? [P] : [];
    },
  });
  const dir = createPrincipalDirectory({ client, ttlMs: 60_000, now: () => now });
  return { state, dir, advance: (ms: number) => (now += ms) };
}

describe("PrincipalDirectory", () => {
  test("caches for the TTL", async () => {
    const { state, dir, advance } = setup();
    await dir.principal(P.id);
    await dir.principal(P.id);
    expect(state.calls).toBe(1);
    advance(60_000);
    await dir.principal(P.id);
    expect(state.calls).toBe(2);
  });

  test("serves a stale entry while the plane is down", async () => {
    const { state, dir, advance } = setup();
    await dir.principal(P.id);
    state.down = true;
    advance(10 * 60_000);
    expect(await dir.principal(P.id)).toEqual(P);
  });

  test("serves a stale entry when the plane answers 5xx", async () => {
    const { state, dir, advance } = setup();
    await dir.identity("matrix", "@x:id.test");
    state.down = true;
    state.status = 503;
    advance(10 * 60_000);
    expect(await dir.identity("matrix", "@x:id.test")).toEqual({ principalId: P.id, kind: "agent", suspended: false });
  });

  test("a 4xx refusal is not papered over with a stale entry", async () => {
    const { state, dir, advance } = setup();
    await dir.principal(P.id);
    state.down = true;
    state.status = 403;
    advance(10 * 60_000);
    await expect(dir.principal(P.id)).rejects.toBeInstanceOf(OrgPlaneError);
  });

  test("a cold miss while the plane is down throws, so callers fail closed and can say why", async () => {
    const { state, dir } = setup();
    state.down = true;
    await expect(dir.identity("matrix", "@x:id.test")).rejects.toBeInstanceOf(OrgPlaneError);
  });

  test("an unknown principal is cached as null too", async () => {
    const { state, dir } = setup();
    expect(await dir.principal("prn_bbbbbbbbbbbbbbbbbbbb")).toBeNull();
    await dir.principal("prn_bbbbbbbbbbbbbbbbbbbb");
    expect(state.calls).toBe(1);
  });

  test("invalidate(id) forces the next read", async () => {
    const { state, dir } = setup();
    await dir.principal(P.id);
    dir.invalidate(P.id);
    await dir.principal(P.id);
    expect(state.calls).toBe(2);
  });

  test("list() with no kind asks for every kind the plane lists", async () => {
    const { dir } = setup();
    expect(await dir.list()).toEqual([P]);
    expect(await dir.list("human")).toEqual([]);
  });
  // Security review finding 7c: a last-good grant was served for as long as the outage lasted, so
  // a grant revoked at the plane kept authorizing dispatch indefinitely. Stale use is capped.
  test("a stale entry is served for at most 15 minutes of outage, then the read fails closed", async () => {
    const { state, dir, advance } = setup();
    await dir.principal(P.id);
    state.down = true;
    advance(14 * 60_000 + 59_000);
    expect(await dir.principal(P.id)).toEqual(P); // fetched 14m59s ago
    advance(2_000);
    await expect(dir.principal(P.id)).rejects.toBeInstanceOf(OrgPlaneError); // 15m01s
  });

  test("the 15 minutes count from the last good answer, not from the start of the outage", async () => {
    const { state, dir, advance } = setup();
    await dir.principal(P.id);
    advance(10 * 60_000);
    await dir.principal(P.id); // refreshed (TTL passed, plane up)
    state.down = true;
    advance(14 * 60_000);
    expect(await dir.principal(P.id)).toEqual(P);
  });

  test("identitiesOf is cached for the TTL, stale while down, and dropped by invalidate(id)", async () => {
    const { state, dir, advance } = setup();
    expect(await dir.identitiesOf(P.id, "matrix")).toEqual([{ system: "matrix", externalId: "@agent_cody:id.test" }]);
    expect(await dir.identitiesOf(P.id, "matrix")).toEqual([{ system: "matrix", externalId: "@agent_cody:id.test" }]);
    expect(state.calls).toBe(1);
    advance(61_000);
    state.down = true;
    expect(await dir.identitiesOf(P.id, "matrix")).toEqual([{ system: "matrix", externalId: "@agent_cody:id.test" }]);
    state.down = false;
    dir.invalidate(P.id);
    await dir.identitiesOf(P.id, "matrix");
    expect(state.calls).toBe(3);
    expect(await dir.identitiesOf("prn_unknown", "matrix")).toBeNull();
  });
});
