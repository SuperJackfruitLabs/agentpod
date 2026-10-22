import { describe, expect, test } from "bun:test";
import { bridgeReadiness, type BridgeReadinessDeps } from "./station-readiness";

const now = () => new Date("2026-10-23T01:02:03.000Z");
const scope = { tenantId: "fleet_x" };

function deps(over: Partial<BridgeReadinessDeps>): BridgeReadinessDeps {
  return {
    strictWork: async () => ({ required: false, version: null }),
    stationReady: async () => ({ ready: true }),
    now,
    ...over,
  };
}

describe("bridgeReadiness answers what the dispatch cycle would decide", () => {
  test("an ordinary ready station is ready", async () => {
    expect(await bridgeReadiness(scope, "station_a", deps({}))).toEqual({
      ready: true,
      reason: null,
      checkedAt: "2026-10-23T01:02:03.000Z",
      strictWork: { required: false, version: null },
    });
  });

  test("a Salaam station without strict work is not ready, with the bridge's reason, and the gates are not asked", async () => {
    let asked = false;
    const r = await bridgeReadiness(scope, "station_s", deps({
      strictWork: async () => ({ required: true, version: null, reason: "Salaam strict work version 1 is not freshly available" }),
      stationReady: async () => { asked = true; return { ready: true }; },
    }));
    expect(r).toMatchObject({ ready: false, reason: "Salaam strict work version 1 is not freshly available", strictWork: { required: true, version: null } });
    expect(asked).toBe(false);
  });

  test("strict work available, then the station's own gates decide", async () => {
    const r = await bridgeReadiness(scope, "station_s", deps({
      strictWork: async () => ({ required: true, version: 1 }),
      stationReady: async () => ({ ready: false, reason: "Node is offline." }),
    }));
    expect(r).toMatchObject({ ready: false, reason: "Node is offline.", strictWork: { required: true, version: 1 } });
  });

  test("the station is looked up in the caller's workspace", async () => {
    let seen: unknown;
    await bridgeReadiness(scope, "station_a", deps({
      strictWork: async (i) => { seen = i; return { required: false, version: null }; },
    }));
    expect(seen).toMatchObject({ stationId: "station_a", tenantId: "fleet_x" });
  });
});
