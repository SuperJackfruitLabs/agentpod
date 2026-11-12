import { describe, expect, test } from "bun:test";
import { CatalogEntry, CatalogResponse, CatalogStationsResponse, StationCapabilities } from "./capability-catalog";

const ROW = {
  stationId: "stn_1",
  principalId: null,
  harness: "salaam",
  isolation: { level: "sandbox", runtime: "runsc", proof: "installed" },
  model: { id: "kimi-k2", proof: "probed" },
  tools: [{ id: "cli:stk", proof: "probed" }],
  credentials: [{ name: "forge:github", instance: "https://github.com", proof: "installed" }],
};

describe("capability catalog shapes", () => {
  test("a station row and the responses parse", () => {
    expect(StationCapabilities.parse(ROW)).toEqual(ROW);
    expect(CatalogStationsResponse.parse({ stations: [ROW] }).stations).toHaveLength(1);
    expect(
      CatalogResponse.parse({
        entries: [{ id: "cli:stk", kind: "cli", name: "stk", version: null, source: "supertoolkit", licence: "Apache-2.0", credentials: [] }],
      }).entries[0]?.id,
    ).toBe("cli:stk");
  });

  test("an unknown proof, isolation or kind is refused, and so is a credential value", () => {
    expect(StationCapabilities.safeParse({ ...ROW, tools: [{ id: "x", proof: "certain" }] }).success).toBe(false);
    expect(StationCapabilities.safeParse({ ...ROW, isolation: { ...ROW.isolation, level: "vm" } }).success).toBe(false);
    expect(
      CatalogEntry.safeParse({ id: "x", kind: "plugin", name: "x", version: null, source: "s", licence: null, credentials: [] }).success,
    ).toBe(false);
    expect(
      StationCapabilities.safeParse({ ...ROW, credentials: [{ ...ROW.credentials[0], token: "secret" }] }).success,
    ).toBe(false);
  });
});
