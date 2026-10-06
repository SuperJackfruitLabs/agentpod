import { describe, expect, test } from "bun:test";
import { abandonPlaneAgent, checkPlaneAgent, createPlaneAgent, grantDispatchTo } from "./agent-placement";
import { OrgPlaneError, type PlanePrincipal } from "./client";

function fakes(principals: Record<string, PlanePrincipal> = {}, o: { linkFails?: boolean; suspendFails?: boolean } = {}) {
  const calls: string[] = [];
  const invalidated: Array<string | undefined> = [];
  const client = () => ({
    createAgent: async (i: { handle: string; displayName: string }) => (calls.push(`create ${i.handle}`), { id: "prn_cccccccccccccccccccc" }),
    linkIdentity: async (id: string, system: string, ext: string) => {
      calls.push(`link ${id} ${system} ${ext}`);
      if (o.linkFails) throw new OrgPlaneError(0, "unreachable");
    },
    putGrant: async (id: string, g: unknown) => void calls.push(`grant ${id} ${JSON.stringify(g)}`),
    suspend: async (id: string) => {
      calls.push(`suspend ${id}`);
      if (o.suspendFails) throw new OrgPlaneError(0, "unreachable");
    },
  });
  const directory = () => ({
    principal: async (id: string) => principals[id] ?? null,
    invalidate: (id?: string) => void invalidated.push(id),
  });
  return { calls, invalidated, deps: { client, directory } };
}

const human = (grant: PlanePrincipal["grant"]): PlanePrincipal => ({
  id: "prn_hhhhhhhhhhhhhhhhhhhh", kind: "human", handle: "op", displayName: null, organizationId: null,
  suspended: false, grant,
});

describe("agent placement under the plane", () => {
  test("creates the agent and links its Matrix id", async () => {
    const { calls, deps } = fakes();
    expect(await createPlaneAgent({ handle: "cody", displayName: "Cody", matrixDomain: "id.test" }, deps)).toBe("prn_cccccccccccccccccccc");
    expect(calls).toEqual(["create cody", "link prn_cccccccccccccccccccc matrix @agent_cody:id.test"]);
  });

  test("no Matrix domain, no link", async () => {
    const { calls, deps } = fakes();
    await createPlaneAgent({ handle: "cody", displayName: "Cody", matrixDomain: null }, deps);
    expect(calls).toEqual(["create cody"]);
  });

  test("an agent whose Matrix link failed is suspended, and the failure is thrown", async () => {
    const { calls, deps } = fakes({}, { linkFails: true });
    await expect(createPlaneAgent({ handle: "cody", displayName: "Cody", matrixDomain: "id.test" }, deps)).rejects.toBeInstanceOf(OrgPlaneError);
    expect(calls).toEqual(["create cody", "link prn_cccccccccccccccccccc matrix @agent_cody:id.test", "suspend prn_cccccccccccccccccccc"]);
  });

  test("grantDispatchTo appends once and keeps reach and scopes", async () => {
    const { calls, invalidated, deps } = fakes({ prn_hhhhhhhhhhhhhhhhhhhh: human({ mayDispatch: ["prn_x"], mayGrantReach: true, scopes: ["runs:write"] }) });
    await grantDispatchTo("prn_hhhhhhhhhhhhhhhhhhhh", "prn_cccccccccccccccccccc", deps);
    await grantDispatchTo("prn_hhhhhhhhhhhhhhhhhhhh", "prn_x", deps);
    expect(calls[0]).toBe(`grant prn_hhhhhhhhhhhhhhhhhhhh ${JSON.stringify({ mayDispatch: ["prn_x", "prn_cccccccccccccccccccc"], mayGrantReach: true, scopes: ["runs:write"] })}`);
    expect(calls).toHaveLength(1); // already present: no write
    expect(invalidated).toEqual(["prn_hhhhhhhhhhhhhhhhhhhh"]);
  });

  test("a human with no grant gets one naming just the agent", async () => {
    const { calls, deps } = fakes({ prn_hhhhhhhhhhhhhhhhhhhh: human(null) });
    await grantDispatchTo("prn_hhhhhhhhhhhhhhhhhhhh", "prn_cccccccccccccccccccc", deps);
    expect(calls[0]).toContain(JSON.stringify({ mayDispatch: ["prn_cccccccccccccccccccc"], mayGrantReach: false, scopes: [] }));
  });

  test("checkPlaneAgent refuses humans, unknowns and suspended agents", async () => {
    const agent = { ...human(null), id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent" as const };
    const { deps } = fakes({ [agent.id]: agent, susp: { ...agent, id: "susp", suspended: true }, prn_hhhhhhhhhhhhhhhhhhhh: human(null) });
    expect(await checkPlaneAgent(agent.id, deps)).toBe("ok");
    expect(await checkPlaneAgent("susp", deps)).toBe("suspended");
    expect(await checkPlaneAgent("prn_hhhhhhhhhhhhhhhhhhhh", deps)).toBe("not-found");
    expect(await checkPlaneAgent("nope", deps)).toBe("not-found");
  });

  test("abandonPlaneAgent suspends", async () => {
    const { calls, deps } = fakes();
    await abandonPlaneAgent("prn_cccccccccccccccccccc", deps);
    expect(calls).toEqual(["suspend prn_cccccccccccccccccccc"]);
  });

  test("abandonPlaneAgent never throws: the placement's own failure is the answer", async () => {
    const { calls, deps } = fakes({}, { suspendFails: true });
    await abandonPlaneAgent("prn_cccccccccccccccccccc", deps);
    expect(calls).toEqual(["suspend prn_cccccccccccccccccccc"]);
  });
});
