import { test, expect, vi, beforeEach } from "vitest";
import * as api from "$lib/api/client";
import { stations, loadDetected, adopt, loadAdopted } from "./stations.svelte";

beforeEach(() => vi.restoreAllMocks());

const mockDetected = [
  {
    key: "claude://workspace",
    harness: "claude",
    kind: "leaf" as const,
    displayName: "Workspace",
    parentKey: null,
    workspacePath: "/home/user/workspace",
    capabilities: ["health", "logs"] as ("health" | "logs")[],
    adopted: false,
  },
];

const mockStationRow = {
  id: "station_abc123",
  userId: "user_1",
  nodeId: "node_1",
  harness: "claude",
  stationKey: "claude://workspace",
  kind: "leaf",
  parentStationId: null,
  displayName: "Workspace",
  workspacePath: "/home/user/workspace",
  capabilities: ["health", "logs"],
  matrixId: null, purpose: null,
  adoptedAt: new Date("2026-06-22T00:00:00Z"),
  createdAt: new Date("2026-06-22T00:00:00Z"),
};

test("loadDetected populates detected list", async () => {
  vi.spyOn(api, "listDetected").mockResolvedValue(mockDetected);

  await loadDetected("node_1");

  expect(stations.detected).toHaveLength(1);
  expect(stations.detected[0].key).toBe("claude://workspace");
  expect(stations.detected[0].adopted).toBe(false);
});

test("loadDetected sets isLoading false after completion", async () => {
  vi.spyOn(api, "listDetected").mockResolvedValue([]);

  await loadDetected("node_1");

  expect(stations.isLoading).toBe(false);
});

test("loadDetected sets error on failure", async () => {
  vi.spyOn(api, "listDetected").mockRejectedValue(new Error("network error"));

  await loadDetected("node_1");

  expect(stations.error).toBe("network error");
  expect(stations.isLoading).toBe(false);
});

test("adopt calls adoptStations then reloads adopted via listStations", async () => {
  vi.spyOn(api, "adoptStations").mockResolvedValue([mockStationRow]);
  vi.spyOn(api, "listStations").mockResolvedValue([mockStationRow]);

  await adopt("node_1", ["claude://workspace"]);

  expect(api.adoptStations).toHaveBeenCalledWith("node_1", ["claude://workspace"]);
  expect(api.listStations).toHaveBeenCalledWith("node_1");
  expect(stations.adopted).toHaveLength(1);
  expect(stations.adopted[0].stationKey).toBe("claude://workspace");
});

test("loadAdopted populates adopted list", async () => {
  vi.spyOn(api, "listStations").mockResolvedValue([mockStationRow]);

  await loadAdopted("node_1");

  expect(stations.adopted).toHaveLength(1);
  expect(stations.adopted[0].id).toBe("station_abc123");
});

test("loadAdopted sets error on failure", async () => {
  vi.spyOn(api, "listStations").mockRejectedValue(new Error("server error"));

  await loadAdopted("node_1");

  expect(stations.error).toBe("server error");
  expect(stations.isLoading).toBe(false);
});
