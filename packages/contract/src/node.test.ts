import { describe, expect, test } from "bun:test";
import { RemoveNodeResponse, RemoveNodeRefusal, RemoveNodeRefusalCode } from "./node";

describe("removing a node", () => {
  test("a removal says which node went, which stations went with it, and whether a session was cut", () => {
    const r = RemoveNodeResponse.parse({
      ok: true,
      node: { id: "node_1", name: "build-01" },
      stationsRemoved: [{ id: "stn_1", stationKey: "hermes:default" }],
      disconnected: true,
    });
    expect(r.stationsRemoved).toHaveLength(1);
    expect(r.disconnected).toBe(true);
  });

  test("a removal that reports success cannot be spelled ok:false", () => {
    expect(
      RemoveNodeResponse.safeParse({ ok: false, node: { id: "n", name: "n" }, stationsRemoved: [], disconnected: false })
        .success
    ).toBe(false);
  });

  test("every refusal names its reason with a code a caller can branch on", () => {
    expect(RemoveNodeRefusalCode.options.sort()).toEqual(["bridged", "online", "provisioned"]);
    const r = RemoveNodeRefusal.parse({
      ok: false,
      code: "provisioned",
      error: "use fleet runtimes rm",
      runtimeId: "rt_1",
    });
    expect(r.runtimeId).toBe("rt_1");
    expect(RemoveNodeRefusal.safeParse({ ok: false, code: "busy", error: "x" }).success).toBe(false);
  });
});
