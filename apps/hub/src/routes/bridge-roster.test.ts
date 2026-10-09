import { expect, test } from "bun:test";
import { createBridgeRosterRoute } from "./bridge-roster";

const READER = "prn_0000000000000000c0b3";
function app(kind = "service", sub = READER, token = true) {
  return createBridgeRosterRoute({
    verify: async () =>
      token
        ? ({ ok: true, caller: { sub, principalKind: kind, tenantId: "tnt_1", claims: {} } } as never)
        : ({ ok: false, status: 401 } as never),
    readers: () => [READER],
    boards: async (tenantId, prn) =>
      tenantId === "tnt_1" && prn === "prn_000000000000000000a2" ? ["brd_00000000000000b1"] : [],
  });
}
const get = (a: ReturnType<typeof app>, prn: string, authorization: string | null = "Bearer x.y.z") =>
  a.request(`/api/bridge/principals/${prn}/boards`, { headers: authorization ? { authorization } : {} });

test("a listed service reads an agent's boards", async () => {
  const r = await get(app(), "prn_000000000000000000a2");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ boards: ["brd_00000000000000b1"] });
});
test("a principal with no rows answers an empty list", async () => {
  const r = await get(app(), "prn_000000000000000000a3");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ boards: [] });
});
test("an unlisted service, a person or an agent is refused", async () => {
  expect((await get(app("service", "prn_0000000000000000c0b9"), "prn_000000000000000000a2")).status).toBe(403);
  expect((await get(app("human"), "prn_000000000000000000a2")).status).toBe(403);
  expect((await get(app("agent"), "prn_000000000000000000a2")).status).toBe(403);
});
test("no bearer, or a token that does not verify, is 401", async () => {
  expect((await get(app(), "prn_000000000000000000a2", null)).status).toBe(401);
  expect((await get(app("service", READER, false), "prn_000000000000000000a2")).status).toBe(401);
});
test("a malformed principal is 400", async () => {
  expect((await get(app(), "not-a-prn")).status).toBe(400);
});
