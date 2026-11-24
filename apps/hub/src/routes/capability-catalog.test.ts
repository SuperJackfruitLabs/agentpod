import { expect, test } from "bun:test";
import { CAPABILITY_CATALOG, contractChecked } from "../../tests/helpers/agentpod-contract";
import { catalogReaders, createCapabilityCatalogRoute } from "./capability-catalog";
import { CatalogResponse, CatalogStationsResponse, StationCapabilities as StationRow } from "@agentpod/contract";
import type { CatalogEntry, StationCapabilities } from "../services/catalog";

const READER = "prn_0000000000000000c0b3";
const ENTRY: CatalogEntry = {
  id: "harness:hermes",
  kind: "harness",
  name: "hermes",
  version: null,
  source: "agentpod",
  licence: null,
  credentials: [],
};
const ROW: StationCapabilities = {
  stationId: "stn_00000000000000c1",
  principalId: "prn_000000000000000000a2",
  harness: "hermes",
  isolation: { level: "host", runtime: null, proof: "declared" },
  model: null,
  tools: [{ id: "harness:hermes", proof: "installed" }],
  credentials: [],
};

/** Every answer is held to treaty's capability-catalog.v1 (`contractChecked`). */
function app(kind: "service" | "human" | "agent" = "service", sub = READER, token = true) {
  return contractChecked(createCapabilityCatalogRoute({
    verify: async () =>
      token ? { ok: true, caller: { sub, principalKind: kind, tenantId: "tnt_1" } } : { ok: false, status: 401 },
    readers: () => [READER],
    catalog: async (tenantId) => (tenantId === "tnt_1" ? [ENTRY] : []),
    stations: async (tenantId, only) =>
      tenantId === "tnt_1" && (!only || only.includes(ROW.stationId)) ? [ROW] : [],
  }), CAPABILITY_CATALOG);
}
const get = (a: ReturnType<typeof app>, path: string, authorization: string | null = "Bearer x.y.z") =>
  a.request(path, { headers: authorization ? { authorization } : {} });

test("a listed service reads the catalog, every station, and one station", async () => {
  // Every answer is the contract's shape (packages/contract/src/capability-catalog.ts).
  expect(CatalogResponse.parse(await (await get(app(), "/api/catalog")).json())).toEqual({ entries: [ENTRY] });
  expect(CatalogStationsResponse.parse(await (await get(app(), "/api/catalog/stations")).json())).toEqual({ stations: [ROW] });
  const one = await get(app(), `/api/catalog/stations/${ROW.stationId}`);
  expect(one.status).toBe(200);
  expect(StationRow.parse(await one.json())).toEqual(ROW);
});

test("a station not in the caller's workspace is 404 not_found; a malformed id is 400 invalid_station", async () => {
  const missing = await get(app(), "/api/catalog/stations/stn_00000000000000c9");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "not_found" });
  const malformed = await get(app(), "/api/catalog/stations/bad.id");
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: "invalid_station" });
});

test("an unlisted service, a person or an agent is refused on every read", async () => {
  for (const path of ["/api/catalog", "/api/catalog/stations", `/api/catalog/stations/${ROW.stationId}`]) {
    expect((await get(app("service", "prn_0000000000000000c0b9"), path)).status).toBe(403);
    expect((await get(app("human"), path)).status).toBe(403);
    expect((await get(app("agent"), path)).status).toBe(403);
  }
});

test("no bearer, or a token that does not verify, is 401", async () => {
  expect((await get(app(), "/api/catalog", null)).status).toBe(401);
  expect((await get(app("service", READER, false), "/api/catalog")).status).toBe(401);
});

test("CATALOG_READERS names the readers; unset, it names none", () => {
  expect(catalogReaders({})).toEqual([]);
  expect(catalogReaders({ CATALOG_READERS: "" })).toEqual([]);
  expect(catalogReaders({ CATALOG_READERS: ` ${READER} , prn_0000000000000000c0b4,` })).toEqual([READER, "prn_0000000000000000c0b4"]);
});
