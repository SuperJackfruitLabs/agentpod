import { expect, test } from "bun:test";
import { PluginOperationPlan, PluginOperationReceipt, PluginPlanRequest, SkillHubOperation } from "./index";
import { pluginPlanFixture, pluginRefusalFixture } from "./fixtures/plugin-operation";

test("a plugin plan either describes its change or refuses with a reason", () => {
  expect(PluginOperationPlan.safeParse(pluginPlanFixture).success).toBe(true);
  expect(PluginOperationPlan.safeParse(pluginRefusalFixture).success).toBe(true);
  expect(PluginOperationPlan.safeParse({ ...pluginPlanFixture, refusal: "no" }).success).toBe(false);
  expect(PluginOperationPlan.safeParse({ ...pluginRefusalFixture, refusal: null }).success).toBe(false);
  // Only enable is gated on the node's Hermes version probe.
  expect(PluginOperationPlan.safeParse({ ...pluginPlanFixture, gate: null }).success).toBe(false);
  expect(PluginOperationPlan.safeParse({ ...pluginRefusalFixture, gate: pluginPlanFixture.gate }).success).toBe(false);
  // The plugin is the one apn ships; a plan cannot name another.
  expect(PluginOperationPlan.safeParse({ ...pluginPlanFixture, binding: { ...pluginPlanFixture.binding, plugin: "other" } }).success).toBe(false);
  expect(PluginOperationPlan.safeParse({ ...pluginPlanFixture, path: "/etc" }).success).toBe(false);
});

test("a receipt is complete exactly when applied", () => {
  const receipt = { plan: pluginPlanFixture, phase: "applied", updatedAt: "2026-09-25T10:00:01Z", completedAt: "2026-09-25T10:00:01Z", error: null };
  expect(PluginOperationReceipt.safeParse(receipt).success).toBe(true);
  expect(PluginOperationReceipt.safeParse({ ...receipt, completedAt: null }).success).toBe(false);
  expect(PluginOperationReceipt.safeParse({ ...receipt, phase: "conflict" }).success).toBe(false);
});

test("the Console asks only for an action; the station and plugin come from the route", () => {
  const requestId = "0b8f7a33-2c86-4f0e-9d5b-8a1f2b3c4d5e";
  expect(PluginPlanRequest.safeParse({ requestId, action: "enable" }).success).toBe(true);
  expect(PluginPlanRequest.safeParse({ requestId, action: "activate" }).success).toBe(false);
  expect(PluginPlanRequest.safeParse({ requestId, action: "enable", plugin: "x" }).success).toBe(false);
});

test("a hub plugin operation carries only plugin actions", () => {
  const operation = {
    id: "a".repeat(32), stationId: "station", nodeId: "node_fixture", stationKey: "hermes:fixture", harness: "hermes",
    profile: "agentpod-live", kind: "plugin", action: "enable", artifactId: null, state: "planned", error: null,
    inFlight: false, createdAt: "2026-09-25T10:00:00Z", updatedAt: "2026-09-25T10:00:00Z", plan: pluginPlanFixture, receipt: null,
  };
  expect(SkillHubOperation.safeParse(operation).success).toBe(true);
  expect(SkillHubOperation.safeParse({ ...operation, action: "activate" }).success).toBe(false);
  expect(SkillHubOperation.safeParse({ ...operation, kind: "native" }).success).toBe(false);
  expect(SkillHubOperation.safeParse({ ...operation, action: "disable" }).success).toBe(false); // plan says enable
});
