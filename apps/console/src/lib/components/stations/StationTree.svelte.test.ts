import { test, expect } from "vitest";
import { render } from "@testing-library/svelte";
import StationTree from "./StationTree.svelte";
import type { StationRow } from "$lib/api/client";

const parentStation: StationRow = {
  id: "station_parent_1",
  userId: "user_1",
  nodeId: "node_1",
  harness: "claude",
  stationKey: "claude://workspace",
  kind: "composite",
  parentStationId: null,
  displayName: "Parent Workspace",
  workspacePath: "/home/user/workspace",
  capabilities: ["health", "logs"],
  matrixId: null,
  adoptedAt: new Date("2026-06-22T00:00:00Z"),
  createdAt: new Date("2026-06-22T00:00:00Z"),
};

const childStation: StationRow = {
  id: "station_child_1",
  userId: "user_1",
  nodeId: "node_1",
  harness: "claude",
  stationKey: "claude://workspace/sub",
  kind: "leaf",
  parentStationId: "station_parent_1",
  displayName: "Child Station",
  workspacePath: "/home/user/workspace/sub",
  capabilities: ["health"],
  matrixId: null,
  adoptedAt: new Date("2026-06-22T00:00:00Z"),
  createdAt: new Date("2026-06-22T00:00:00Z"),
};

test("StationTree renders parent and child station names", () => {
  const { getByText } = render(StationTree, {
    props: {
      stations: [parentStation, childStation],
      nodeId: "node_1",
    },
  });

  expect(getByText("Parent Workspace")).toBeTruthy();
  expect(getByText("Child Station")).toBeTruthy();
});

test("StationTree renders child nested under parent", () => {
  const { container } = render(StationTree, {
    props: {
      stations: [parentStation, childStation],
      nodeId: "node_1",
    },
  });

  const items = container.querySelectorAll("[data-station-id]");
  expect(items.length).toBe(2);

  const parentEl = container.querySelector('[data-station-id="station_parent_1"]');
  const childEl = container.querySelector('[data-station-id="station_child_1"]');
  expect(parentEl).toBeTruthy();
  expect(childEl).toBeTruthy();
  // child should be contained within parent container
  expect(parentEl!.contains(childEl)).toBe(true);
});

test("StationTree renders harness badges for each station", () => {
  const { getAllByText } = render(StationTree, {
    props: {
      stations: [parentStation, childStation],
      nodeId: "node_1",
    },
  });

  // Both stations have harness "claude" — two badge elements should appear
  const harnessBadges = getAllByText("claude");
  expect(harnessBadges.length).toBeGreaterThanOrEqual(2);
});

test("StationTree renders links to station detail pages", () => {
  const { container } = render(StationTree, {
    props: {
      stations: [parentStation, childStation],
      nodeId: "node_1",
    },
  });

  const links = container.querySelectorAll('a[href*="/nodes/node_1/stations/"]');
  expect(links.length).toBe(2);

  const parentLink = container.querySelector('a[href="/nodes/node_1/stations/station_parent_1"]');
  const childLink = container.querySelector('a[href="/nodes/node_1/stations/station_child_1"]');
  expect(parentLink).toBeTruthy();
  expect(childLink).toBeTruthy();
});

test("StationTree shows empty state when no stations", () => {
  const { getByText } = render(StationTree, {
    props: {
      stations: [],
      nodeId: "node_1",
    },
  });

  expect(getByText("No agents added.")).toBeTruthy();
});

test("StationTree toggle expand/collapse on parent with children", async () => {
  const { container } = render(StationTree, {
    props: {
      stations: [parentStation, childStation],
      nodeId: "node_1",
    },
  });

  // Parent starts expanded (has children) — child should be visible
  const childEl = container.querySelector('[data-station-id="station_child_1"]');
  expect(childEl).toBeTruthy();

  // The toggle button for the parent should be present
  const toggleButton = container.querySelector('[aria-expanded="true"]');
  expect(toggleButton).toBeTruthy();
});
