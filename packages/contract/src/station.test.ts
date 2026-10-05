import { describe, it, test, expect } from "bun:test";
import { Station, CapabilityList, Capability } from "./station";

it("Station accepts an optional nullable matrixId", () => {
  expect(Station.parse({ key:"k", harness:"hermes", kind:"leaf", displayName:"d", parentKey:null, workspacePath:null, capabilities:[], matrixId:"@a:id.agentpod.dev" }).matrixId).toBe("@a:id.agentpod.dev");
  expect(Station.parse({ key:"k", harness:"hermes", kind:"leaf", displayName:"d", parentKey:null, workspacePath:null, capabilities:[] }).matrixId).toBeUndefined();
  expect(Station.parse({ key:"k", harness:"hermes", kind:"leaf", displayName:"d", parentKey:null, workspacePath:null, capabilities:[], matrixId:null }).matrixId).toBeNull();
});

it("CapabilityList filters unknown capability strings instead of throwing", () => {
  expect(CapabilityList.parse(["health", "acp", "future-cap"])).toEqual(["health", "acp"]);
});

it("Station parses (instead of rejecting) when a newer node advertises an unknown capability", () => {
  const s = Station.parse({
    key: "k", harness: "hermes", kind: "leaf", displayName: "d", parentKey: null,
    workspacePath: null, capabilities: ["health", "future-cap"],
  });
  expect(s.capabilities).toEqual(["health"]);
});

/**
 * Regression: `config.manage` reached the hub on the wire and was silently
 * dropped, so three merged PRs of declared-harness-config could not activate
 * on a real fleet. `CapabilityList` filters unknown strings by design — so an
 * old hub survives a newer node — and that same tolerance made a NEW hub
 * discard a NEW node's capability, with no error anywhere.
 *
 * Every hub test hand-built station rows DOWNSTREAM of this parse, hard-coding
 * the capability straight into the database, so none of them could see it.
 * These tests go through the real parse, which is the only place the bug lived.
 */
describe("a capability the node advertises survives the hub's parse", () => {
  // Shaped like a real Hermes profile as the node reports one: composite,
  // parented under the root, with an absolute workspace path.
  const station = {
    key: "hermes:one",
    harness: "hermes",
    kind: "composite" as const,
    displayName: "one",
    parentKey: "hermes",
    workspacePath: "/home/x/.hermes/profiles/one",
    capabilities: ["health", "logs", "plugins.manage", "config.manage"],
  };

  test("config.manage is not filtered out of a detect frame", () => {
    const parsed = Station.parse(station);
    expect(parsed.capabilities).toContain("config.manage");
  });

  test("every capability a descriptor can advertise is in the enum", () => {
    // The filter is silent, so a capability missing from the enum is invisible
    // rather than an error. Anything the node can send must be listed here.
    for (const cap of [
      "skills.manage",
      "skills.native",
      "plugins.manage",
      "config.manage",
      "matrix.avatar",
    ]) {
      expect(Capability.safeParse(cap).success).toBe(true);
    }
  });

  test("an unknown capability is still filtered rather than rejecting the row", () => {
    // The tolerance itself is deliberate and must not regress: a newer node
    // advertising something this hub has never heard of must not break adopt.
    const parsed = Station.parse({ ...station, capabilities: ["health", "not.a.capability"] });
    expect(parsed.capabilities).toEqual(["health"]);
  });
});
