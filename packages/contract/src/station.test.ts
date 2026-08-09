import { describe, it, expect } from "bun:test";
import { Station, CapabilityList } from "./station";

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
