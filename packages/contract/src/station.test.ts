import { describe, it, test, expect } from "bun:test";
import {
  Station,
  CapabilityList,
  Capability,
  partitionCapabilities,
  unknownCapabilitiesByStation,
} from "./station";

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

/**
 * The drop is tolerated; it is no longer silent.
 *
 * `config.manage` was missing from the enum and `CapabilityList` threw it away
 * with no error at any layer, so three merged PRs could not activate on a real
 * fleet and only manual production verification found it. The filter itself is
 * right — an old hub must survive a newer node — so the fix is not to reject,
 * it is to make what was dropped readable by whoever can log it.
 */
describe("a dropped capability is reportable", () => {
  test("partitionCapabilities reports what the filter keeps and what it drops", () => {
    expect(partitionCapabilities(["health", "config.manage", "future-cap"])).toEqual({
      known: ["health", "config.manage"],
      dropped: ["future-cap"],
    });
  });

  test("the dropped set is exactly what CapabilityList removed", () => {
    // The two must be computed by the same code or they drift, and a drift here
    // is invisible: the whole point is that nobody can see the drop otherwise.
    const raw = ["health", "future-cap", "acp", "another.future.cap"];
    const { known, dropped } = partitionCapabilities(raw);
    expect(CapabilityList.parse(raw)).toEqual(known);
    expect([...known, ...dropped].sort()).toEqual([...raw].sort());
  });

  test("a station that drops nothing reports nothing", () => {
    expect(partitionCapabilities(["health", "logs"]).dropped).toEqual([]);
    expect(
      unknownCapabilitiesByStation([
        { key: "hermes:one", capabilities: ["health", "config.manage"] },
      ])
    ).toEqual([]);
  });

  test("unknownCapabilitiesByStation names the station and the dropped strings", () => {
    // The shape a hub holds: the RAW detect payload, before the parse that is
    // the last place those strings exist.
    expect(
      unknownCapabilitiesByStation([
        { key: "hermes:one", capabilities: ["health", "config.manage"] },
        { key: "hermes:two", capabilities: ["health", "config.manage", "matrix.avatar"] },
        { key: "codex:three", capabilities: ["health", "future-cap", "another-one"] },
      ])
    ).toEqual([{ key: "codex:three", dropped: ["future-cap", "another-one"] }]);
  });

  test("it is safe to run beside a safeParse, whatever the payload is", () => {
    // It runs on the same bytes a `safeParse` is about to read, on a path that
    // must never throw (refreshAdoptedCapabilities runs on node connect).
    expect(unknownCapabilitiesByStation(undefined)).toEqual([]);
    expect(unknownCapabilitiesByStation({ not: "an array" })).toEqual([]);
    expect(unknownCapabilitiesByStation([null, 7, "x"])).toEqual([]);
    expect(unknownCapabilitiesByStation([{ key: 1, capabilities: ["x"] }])).toEqual([]);
    expect(unknownCapabilitiesByStation([{ key: "k" }])).toEqual([]);
    expect(unknownCapabilitiesByStation([{ key: "k", capabilities: [1, "future-cap"] }])).toEqual([
      { key: "k", dropped: ["future-cap"] },
    ]);
  });

  test("reporting the drop does not make an unknown capability reject the row", () => {
    // The tolerance is the part that must not regress. A newer node advertising
    // something this hub has never heard of still parses.
    const parsed = Station.safeParse({
      key: "hermes:one", harness: "hermes", kind: "leaf", displayName: "one",
      parentKey: null, workspacePath: null,
      capabilities: ["health", "config.manage", "capability-from-the-future"],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.capabilities).toEqual(["health", "config.manage"]);
    expect(Capability.safeParse("capability-from-the-future").success).toBe(false);
  });
});
