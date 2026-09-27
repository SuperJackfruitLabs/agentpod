import { test, expect, vi, afterEach } from "vitest";
import * as client from "./client";
import * as plugins from "./plugins";
import { pluginPlanFixture } from "../../../../../packages/contract/src/fixtures/plugin-operation";

afterEach(() => vi.restoreAllMocks());
const operation = {
  id: pluginPlanFixture.operationId, stationId: "station_1", nodeId: "node_fixture", stationKey: "hermes:fixture",
  harness: "hermes", profile: "agentpod-live", kind: "plugin", action: "enable", artifactId: null, state: "planned",
  error: null, inFlight: false, createdAt: pluginPlanFixture.createdAt, updatedAt: pluginPlanFixture.createdAt,
  plan: pluginPlanFixture, receipt: null,
};

test("plans with only a request id and an action", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue(operation);
  await plugins.planPluginOperation("station_1", "enable", "0b8f7a33-2c86-4f0e-9d5b-8a1f2b3c4d5e");
  expect(http).toHaveBeenCalledWith("/api/stations/station_1/plugins/plan", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "0b8f7a33-2c86-4f0e-9d5b-8a1f2b3c4d5e", action: "enable" }),
  });
});

test("refuses a foreign station, another plugin, or an operation of another kind", async () => {
  const http = vi.spyOn(client, "http");
  for (const data of [
    { ...operation, stationId: "other" },
    { ...operation, plan: { ...pluginPlanFixture, binding: { ...pluginPlanFixture.binding, stationKey: "hermes:other" } } },
    { ...operation, profile: "other-plugin" },
  ]) {
    http.mockResolvedValueOnce(data);
    await expect(plugins.getPluginOperation("station_1", operation.id)).rejects.toThrow();
  }
});

test("applies only the reviewed digest", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue(operation);
  await plugins.applyPluginOperation("station_1", operation.id, pluginPlanFixture.planDigest);
  expect(http).toHaveBeenCalledWith(`/api/stations/station_1/plugins/operations/${operation.id}/apply`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planDigest: pluginPlanFixture.planDigest }),
  });
});
