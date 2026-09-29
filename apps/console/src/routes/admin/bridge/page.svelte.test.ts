/**
 * page.svelte.test.ts
 *
 * The bridge roster page — the first place an operator can change what this fleet claims without
 * root on the hub host.
 *
 * Two beliefs this page must never create, and both are asserted here:
 *
 *  - that a credential can be read back. They are stored encrypted and the hub answers only
 *    whether one is set; a field that appeared to hold something would be a lie about what is
 *    knowable, and the honest offer is "replace", never "reveal".
 *  - that a change needs a restart. It does not — the reconciler picks it up within a tick — and
 *    the old environment-variable roster trained everyone to expect otherwise, so the page has to
 *    say so.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, screen } from "@testing-library/svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/api/client", () => ({
  getFleet: vi.fn(),
}));

vi.mock("$lib/api/bridge-agents", () => ({
  listBridgeAgents: vi.fn(),
  createBridgeAgent: vi.fn(),
  updateBridgeAgent: vi.fn(),
  deleteBridgeAgent: vi.fn(),
}));

import Page from "./+page.svelte";
import { getFleet } from "$lib/api/client";
import {
  createBridgeAgent,
  deleteBridgeAgent,
  listBridgeAgents,
  updateBridgeAgent,
  type BridgeAgent,
} from "$lib/api/bridge-agents";

const agent = (over: Partial<BridgeAgent> = {}): BridgeAgent => ({
  key: "coder-kai",
  boardId: "brd_6a899b0f0d054046",
  stationId: "station_1",
  stationName: "Guild Coder",
  hubUserId: "usr_1",
  mode: "accept-edits",
  permissionWaitMs: null,
  maxConcurrency: null,
  profileKey: null,
  enabled: true,
  hasToken: true,
  hasMcpToken: false,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.mocked(listBridgeAgents).mockResolvedValue([agent()]);
  vi.mocked(getFleet).mockResolvedValue({
    stats: {} as never,
    agents: [
      { stationId: "station_1", agentName: "Guild Coder", harness: "hermes" },
      { stationId: "station_2", agentName: "Guild Writer", harness: "hermes" },
    ] as never,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("a rostered agent shows its board and station, and never a credential", async () => {
  render(Page);

  await waitFor(() => expect(screen.getByText("coder-kai")).toBeTruthy());
  expect(screen.getByText(/brd_6a899b0f0d054046/)).toBeTruthy();
  expect(screen.getByText(/Guild Coder/)).toBeTruthy();

  // Nothing offers to show one. "Replace" is the only verb.
  expect(screen.queryByText(/reveal/i)).toBeNull();
  expect(screen.getByText("Replace claim token")).toBeTruthy();
});

test("an agent that can report for itself is marked, because that is not visible anywhere else", async () => {
  vi.mocked(listBridgeAgents).mockResolvedValue([agent({ hasMcpToken: true })]);
  render(Page);

  await waitFor(() => expect(screen.getByText("reports for itself")).toBeTruthy());
  expect(screen.getByText("Replace run-only token")).toBeTruthy();
});

test("an agent with no run-only token is offered one, rather than being marked as lacking", async () => {
  render(Page);
  await waitFor(() => expect(screen.getByText("Add run-only token")).toBeTruthy());
});

test("the page says a change needs no restart — the old roster trained otherwise", async () => {
  render(Page);
  await waitFor(() =>
    expect(screen.getByText(/does not need restarting/i)).toBeTruthy(),
  );
});

test("an empty roster says the bridge is claiming nothing, not that the page is broken", async () => {
  vi.mocked(listBridgeAgents).mockResolvedValue([]);
  render(Page);
  await waitFor(() => expect(screen.getByText(/No agents are rostered/i)).toBeTruthy());
});

test("the station is chosen from the fleet, not typed", async () => {
  render(Page);

  await waitFor(() => expect(screen.getByText("Add an agent")).toBeTruthy());
  await fireEvent.click(screen.getByText("Add an agent"));

  // A picker over adopted stations: the database refuses one that does not exist, and this makes
  // that refusal unreachable rather than merely survivable.
  await waitFor(() => expect(screen.getByText("Guild Writer · hermes")).toBeTruthy());
});

test("disabling one says it finishes its card first, which is what actually happens", async () => {
  vi.mocked(updateBridgeAgent).mockResolvedValue(agent({ enabled: false }));
  const { toast } = await import("svelte-sonner");
  render(Page);

  await waitFor(() => expect(screen.getByText("Disable")).toBeTruthy());
  await fireEvent.click(screen.getByText("Disable"));

  await waitFor(() => expect(updateBridgeAgent).toHaveBeenCalledWith("coder-kai", { enabled: false }));
  expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/finishes the card/i);
});

test("a refusal from the hub is shown, not swallowed", async () => {
  vi.mocked(updateBridgeAgent).mockRejectedValue(new Error("no such station in this workspace"));
  const { toast } = await import("svelte-sonner");
  render(Page);

  await waitFor(() => expect(screen.getByText("Disable")).toBeTruthy());
  await fireEvent.click(screen.getByText("Disable"));

  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("no such station in this workspace"),
  );
  expect(deleteBridgeAgent).not.toHaveBeenCalled();
  expect(createBridgeAgent).not.toHaveBeenCalled();
});
