import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/mcp-proxy";
import McpProxyStatus from "./McpProxyStatus.svelte";

const base = {
  stationId: "station_1",
  stationKey: "hermes:one",
  displayName: "one",
  harness: "hermes",
  eligible: true,
  declared: null,
  serving: true,
  state: "on" as const,
};

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

test("shows the proxy on, read-only, with how to change it", async () => {
  const get = vi.spyOn(api, "getStationMcpProxy").mockResolvedValue(base);
  const view = render(McpProxyStatus, { props: { stationId: "station_1" } });
  await waitFor(() => expect(view.getByTestId("mcp-proxy-state").textContent).toBe("On"));
  expect(get).toHaveBeenCalledWith("station_1");
  expect(view.getByText(/fleet mcp-proxy enable\|disable station_1/)).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
});

test("says why an OpenClaw station is off", async () => {
  vi.spyOn(api, "getStationMcpProxy").mockResolvedValue({ ...base, harness: "openclaw", eligible: false, serving: false, state: "off" });
  const view = render(McpProxyStatus, { props: { stationId: "station_1" } });
  await waitFor(() => expect(view.getByText(/openclaw takes no HTTP MCP servers/)).toBeTruthy());
});

test("names drift", async () => {
  vi.spyOn(api, "getStationMcpProxy").mockResolvedValue({ ...base, declared: true, serving: false, state: "drifted" });
  const view = render(McpProxyStatus, { props: { stationId: "station_1" } });
  await waitFor(() => expect(view.getByTestId("mcp-proxy-state").textContent).toBe("Drifted"));
  expect(view.getByText("Declared on, but the node does not serve it.")).toBeTruthy();
});

test("a failed read says so instead of guessing off", async () => {
  vi.spyOn(api, "getStationMcpProxy").mockRejectedValue(new Error("node offline"));
  const view = render(McpProxyStatus, { props: { stationId: "station_1" } });
  await waitFor(() => expect(view.getByText("node offline")).toBeTruthy());
  expect(view.queryByTestId("mcp-proxy-state")).toBeNull();
});
