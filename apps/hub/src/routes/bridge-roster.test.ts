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
    station: async (tenantId, id) =>
      tenantId === "tnt_1" && id === "stn_00000000000000c1"
        ? { id, key: "notes-station", owner: "prn_000000000000000000a1" }
        : null,
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

const station = (a: ReturnType<typeof app>, id: string, authorization: string | null = "Bearer x.y.z") =>
  a.request(`/api/bridge/stations/${id}`, { headers: authorization ? { authorization } : {} });

test("a listed service reads whose station it is", async () => {
  const r = await station(app(), "stn_00000000000000c1");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ id: "stn_00000000000000c1", key: "notes-station", owner: "prn_000000000000000000a1" });
});
test("a station the tenant does not have is 404", async () => {
  const r = await station(app(), "stn_00000000000000ff");
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: "not found" });
});
test("the station read refuses an unlisted service, a person and an agent", async () => {
  expect((await station(app("service", "prn_0000000000000000c0b9"), "stn_00000000000000c1")).status).toBe(403);
  expect((await station(app("human"), "stn_00000000000000c1")).status).toBe(403);
  expect((await station(app("agent"), "stn_00000000000000c1")).status).toBe(403);
  expect((await station(app(), "stn_00000000000000c1", null)).status).toBe(401);
  expect((await station(app("service", READER, false), "stn_00000000000000c1")).status).toBe(401);
});
test("a malformed station id is 400", async () => {
  expect((await station(app(), "not a station")).status).toBe(400);
});
