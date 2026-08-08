import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup, within } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import type { StationHealth } from "@agentpod/contract";
// Static import ensures module is compiled during file collection, so the
// first test doesn't pay the compilation cost inside its waitFor window.
import HealthPanel from "./HealthPanel.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const healthFull: StationHealth = {
  running: true,
  pid: 12345,
  cpuPct: 3.5,
  memBytes: 104857600,
  diskBytes: 1073741824,
  uptimeSec: 3600,
  lastActivity: "2026-06-27T10:00:00Z",
  note: "All systems go",
};

const healthNulls: StationHealth = {
  running: false,
  pid: null,
  cpuPct: null,
  memBytes: null,
  diskBytes: null,
  uptimeSec: null,
  lastActivity: null,
  note: null,
};

test("HealthPanel renders running state and numeric pid", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthFull);

  const { getByText, getAllByText } = render(HealthPanel, { props: { stationId: "station_1" } });

  await waitFor(() => {
    // running appears (status dot sr-only label + visible text label)
    expect(getAllByText(/running/i).length).toBeGreaterThanOrEqual(1);
    // pid should appear
    expect(getByText(/12345/)).toBeTruthy();
  });

  expect(api.stationHealth).toHaveBeenCalledWith("station_1");
});

test("HealthPanel shows — for null fields", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthNulls);

  const { getAllByText } = render(HealthPanel, { props: { stationId: "station_2" } });

  await waitFor(() => {
    // Should have multiple "—" placeholders for null fields
    const dashes = getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });
});

test("HealthPanel shows loading then data", async () => {
  let resolve!: (v: StationHealth) => void;
  const pending = new Promise<StationHealth>((r) => (resolve = r));
  vi.spyOn(api, "stationHealth").mockReturnValue(pending);

  const { getByText, queryByText } = render(HealthPanel, { props: { stationId: "station_3" } });

  // loading state: skeleton only, no data yet
  expect(queryByText(/12345/)).toBeNull();

  resolve(healthFull);
  await waitFor(() => {
    expect(getByText(/12345/)).toBeTruthy();
  });
});

// ─── Lifecycle controls ───────────────────────────────────────────────────────

test("HealthPanel: no lifecycle buttons rendered when canLifecycle is false (default)", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthFull);

  const { queryByRole, getByText } = render(HealthPanel, {
    props: { stationId: "station_lc" },
  });

  // Wait for health data to appear so we know the panel is fully rendered
  await waitFor(() => expect(getByText(/12345/)).toBeTruthy());

  expect(queryByRole("button", { name: /^start$/i })).toBeNull();
  expect(queryByRole("button", { name: /^stop$/i })).toBeNull();
  expect(queryByRole("button", { name: /^restart$/i })).toBeNull();
});

test("HealthPanel: controls are state-aware — running shows Stop/Restart, never Start", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthFull);

  const { getByRole, queryByRole } = render(HealthPanel, {
    props: { stationId: "station_lc", canLifecycle: true },
  });

  await waitFor(() => {
    expect(getByRole("button", { name: /^stop$/i })).toBeTruthy();
    expect(getByRole("button", { name: /^restart$/i })).toBeTruthy();
  });
  // A running agent must not offer the one action that does nothing.
  expect(queryByRole("button", { name: /^start$/i })).toBeNull();
});

test("HealthPanel: Start (on a stopped agent) calls lifecycle immediately without a dialog", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthNulls);
  vi.spyOn(api, "lifecycle").mockResolvedValue(healthFull);

  const { getByRole, queryByRole } = render(HealthPanel, {
    props: { stationId: "station_lc", canLifecycle: true },
  });

  await waitFor(() => expect(getByRole("button", { name: /^start$/i })).toBeTruthy());
  // A stopped agent shows only Start.
  expect(queryByRole("button", { name: /^stop$/i })).toBeNull();
  expect(queryByRole("button", { name: /^restart$/i })).toBeNull();

  fireEvent.click(getByRole("button", { name: /^start$/i }));

  await waitFor(() =>
    expect(api.lifecycle).toHaveBeenCalledWith("station_lc", "start"),
  );
  // No dialog should be shown
  expect(queryByRole("dialog")).toBeNull();
});

test("HealthPanel: Stop opens confirm dialog; confirming calls lifecycle stop", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthFull);
  vi.spyOn(api, "lifecycle").mockResolvedValue(healthFull);

  const { getByRole } = render(HealthPanel, {
    props: { stationId: "station_lc", canLifecycle: true },
  });

  await waitFor(() => expect(getByRole("button", { name: /^stop$/i })).toBeTruthy());

  fireEvent.click(getByRole("button", { name: /^stop$/i }));

  // Dialog should open
  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());

  // lifecycle must NOT be called before confirming
  expect(api.lifecycle).not.toHaveBeenCalled();

  // Routine stop is a plain confirm (no type-to-confirm), labeled with the action
  const dialog = getByRole("dialog");
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop agent" }));

  await waitFor(() =>
    expect(api.lifecycle).toHaveBeenCalledWith("station_lc", "stop"),
  );
});

test("HealthPanel: Restart opens confirm dialog; confirming calls lifecycle restart", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthFull);
  vi.spyOn(api, "lifecycle").mockResolvedValue(healthFull);

  const { getByRole } = render(HealthPanel, {
    props: { stationId: "station_lc", canLifecycle: true },
  });

  await waitFor(() => expect(getByRole("button", { name: /^restart$/i })).toBeTruthy());

  fireEvent.click(getByRole("button", { name: /^restart$/i }));

  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());

  const dialog = getByRole("dialog");
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Restart agent" }));

  await waitFor(() =>
    expect(api.lifecycle).toHaveBeenCalledWith("station_lc", "restart"),
  );
});

// ─── Matrix ID display ────────────────────────────────────────────────────────

test("HealthPanel: renders Matrix row with matrix.to link when matrixId is set", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthFull);

  const { getByRole, getByText } = render(HealthPanel, {
    props: {
      stationId: "station_mx",
      matrixId: "@analyst-echo:id.agentpod.dev",
    },
  });

  await waitFor(() => expect(getByText(/12345/)).toBeTruthy());

  // The Matrix row label should appear
  expect(getByText(/matrix/i)).toBeTruthy();

  // A link pointing to the matrix.to deep-link must exist
  const link = getByRole("link", { name: /@analyst-echo:id\.agentpod\.dev/ });
  expect(link).toBeTruthy();
  expect(link.getAttribute("href")).toBe(
    "https://matrix.to/#/@analyst-echo:id.agentpod.dev",
  );
  expect(link.getAttribute("rel")).toContain("noopener");
});

test("HealthPanel: no Matrix row when matrixId is null", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthFull);

  const { queryByText, getByText } = render(HealthPanel, {
    props: { stationId: "station_no_mx", matrixId: null },
  });

  await waitFor(() => expect(getByText(/12345/)).toBeTruthy());

  // No Matrix row or matrix.to link should be present
  expect(queryByText(/matrix/i)).toBeNull();
  expect(queryByText(/matrix\.to/)).toBeNull();
});

test("HealthPanel: no Matrix row when matrixId prop is omitted", async () => {
  vi.spyOn(api, "stationHealth").mockResolvedValue(healthFull);

  const { queryByText, getByText } = render(HealthPanel, {
    props: { stationId: "station_no_mx2" },
  });

  await waitFor(() => expect(getByText(/12345/)).toBeTruthy());

  expect(queryByText(/matrix/i)).toBeNull();
});

// ─── Fetch failure + retry ────────────────────────────────────────────────────

test("HealthPanel: fetch failure shows inline error card with Retry; retrying re-fetches and succeeds", async () => {
  const spy = vi
    .spyOn(api, "stationHealth")
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValueOnce(healthFull);

  const { getByText, getByRole, queryByText } = render(HealthPanel, {
    props: { stationId: "station_retry" },
  });

  await waitFor(() => expect(getByText(/network down/i)).toBeTruthy());

  const retryBtn = getByRole("button", { name: /^retry$/i });
  fireEvent.click(retryBtn);

  await waitFor(() => {
    expect(queryByText(/network down/i)).toBeNull();
    expect(getByText(/12345/)).toBeTruthy();
  });

  expect(spy).toHaveBeenCalledTimes(2);
});
