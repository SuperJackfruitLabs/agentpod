/**
 * runtimes/page.svelte.test.ts
 *
 * Tests for the /runtimes page.
 * Asserts:
 *  - renders a PageHeader with title "Runtimes"
 *  - renders runtime rows (name, provider, status, created) from a mocked listRuntimes
 *  - empty state: "No runtimes yet" when listRuntimes returns []
 *  - destroy button opens a type-to-confirm dialog; typing the runtime name and
 *    confirming triggers destroyRuntime
 *  - error state when listRuntimes rejects
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup, screen, within } from "@testing-library/svelte";
import * as api from "$lib/api/client";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  replaceState: vi.fn(),
}));

vi.mock("$app/state", () => ({
  page: {
    url: { pathname: "/runtimes", searchParams: null },
  },
}));

// ---------------------------------------------------------------------------
// Sonner stub (toast used by destroy/start/stop error handlers)
// ---------------------------------------------------------------------------

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Static import — compiled once after all mocks are registered
// ---------------------------------------------------------------------------

import RuntimesPage from "./+page.svelte";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago

/** What the hub's registry reports for the Docker driver. */
const DOCKER_MANIFEST: api.DriverManifest = {
  provider: "docker",
  supportedTiers: ["small", "medium", "large"],
  workspaceStorage: "rootfs",
  stopSemantics: "resumable",
  maxLifetimeMs: null,
  imageBinding: "per-instance",
  idleBehaviour: "never",
  lifecycle: ["start", "stop", "status"],
};

const mockRuntimes = [
  {
    id: "rt-aaa111",
    ownerId: "user-1",
    provider: "docker" as const,
    externalId: null,
    status: "online" as const,
    nodeId: "node-xyz",
    name: "my-runtime",
    resourceTier: "small" as const,
    harness: "none" as const,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: "rt-bbb222",
    ownerId: "user-1",
    provider: "cloudflare" as const,
    externalId: "cf-ext-1",
    status: "stopped" as const,
    nodeId: null,
    name: "cf-runtime",
    resourceTier: "medium" as const,
    harness: "opencode" as const,
    createdAt,
    updatedAt: createdAt,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renders the Runtimes page header", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { container } = render(RuntimesPage);

  await waitFor(() => {
    expect(container.textContent).toContain("Runtimes");
  });
});

test("renders runtime rows with name, provider, and status after loading", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getAllByTestId, getByText } = render(RuntimesPage);

  await waitFor(() => {
    expect(getByText("my-runtime")).toBeTruthy();
    expect(getByText("cf-runtime")).toBeTruthy();
  });

  const rows = getAllByTestId("runtime-row");
  expect(rows.length).toBe(2);

  const badges = getAllByTestId("status-badge");
  expect(badges[0].textContent).toContain("online");
  expect(badges[1].textContent).toContain("stopped");
});

test("shows provider in each row", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getByText } = render(RuntimesPage);

  await waitFor(() => {
    expect(getByText("docker")).toBeTruthy();
    expect(getByText("cloudflare")).toBeTruthy();
  });
});

test("Node column links to the node when present, shows a dash otherwise", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getAllByTestId, getByText } = render(RuntimesPage);

  await waitFor(() => {
    expect(getAllByTestId("runtime-row").length).toBe(2);
  });

  // my-runtime has nodeId "node-xyz" → truncated link to /nodes/node-xyz
  const link = getByText("node-xyz".slice(0, 8)).closest("a");
  expect(link).toBeTruthy();
  expect(link?.getAttribute("href")).toBe("/nodes/node-xyz");

  // cf-runtime has nodeId null → dash, no link
  expect(getByText("—")).toBeTruthy();
});

test("shows a Created column with relative time for each row", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getAllByText, getAllByTestId } = render(RuntimesPage);

  await waitFor(() => {
    expect(getAllByTestId("runtime-row").length).toBe(2);
  });

  // Both fixtures share the same createdAt (5 minutes ago) → two "5m ago" cells
  expect(getAllByText("5m ago").length).toBe(2);
});

test("shows Stop button for online runtime and Start button for stopped runtime", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getAllByTestId } = render(RuntimesPage);

  await waitFor(() => {
    const stopBtns = getAllByTestId("stop-btn");
    const startBtns = getAllByTestId("start-btn");
    expect(stopBtns.length).toBe(1); // online runtime
    expect(startBtns.length).toBe(1); // stopped runtime
  });
});

test("shows Destroy buttons for non-provisioning, non-destroyed runtimes", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getAllByTestId } = render(RuntimesPage);

  await waitFor(() => {
    const destroyBtns = getAllByTestId("destroy-btn");
    expect(destroyBtns.length).toBe(2); // both runtimes qualify
  });
});

test("clicking Destroy opens type-to-confirm dialog; typing the runtime name and confirming calls destroyRuntime", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });
  const destroySpy = vi.spyOn(api, "destroyRuntime").mockResolvedValue(undefined);

  const { getAllByTestId } = render(RuntimesPage);

  // Wait for runtime rows to render
  await waitFor(() => {
    expect(getAllByTestId("destroy-btn").length).toBeGreaterThan(0);
  });

  // Click the first Destroy button (opens the confirm dialog)
  const [firstDestroyBtn] = getAllByTestId("destroy-btn");
  await fireEvent.click(firstDestroyBtn);

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  const input = within(screen.getByRole("dialog")).getByRole("textbox");

  // Wrong input: dialog's confirm button (last "Destroy" button) stays disabled
  await fireEvent.input(input, { target: { value: "wrong" } });
  await waitFor(() => {
    const btns = screen.getAllByRole("button", { name: /destroy/i }) as HTMLButtonElement[];
    expect(btns[btns.length - 1].disabled).toBe(true);
  });

  // Correct input enables the confirm button
  await fireEvent.input(input, { target: { value: "my-runtime" } });
  await waitFor(() => {
    const btns = screen.getAllByRole("button", { name: /destroy/i }) as HTMLButtonElement[];
    expect(btns[btns.length - 1].disabled).toBe(false);
  });

  // Click confirm (last "Destroy" button = dialog's confirm button) — triggers destroyRuntime
  const btns = screen.getAllByRole("button", { name: /destroy/i }) as HTMLButtonElement[];
  await fireEvent.click(btns[btns.length - 1]);

  await waitFor(() => {
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledWith("rt-aaa111");
  });
});

test("shows empty state when listRuntimes returns []", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue([]);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getByTestId } = render(RuntimesPage);

  await waitFor(() => {
    const emptyState = getByTestId("empty-state");
    expect(emptyState.textContent).toContain("No runtimes yet");
  });
});

test("shows empty state CTA button", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue([]);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getByTestId } = render(RuntimesPage);

  await waitFor(() => {
    const ctaBtn = getByTestId("empty-new-runtime-btn");
    expect(ctaBtn).toBeTruthy();
  });
});

test("shows error message when listRuntimes rejects", async () => {
  vi.spyOn(api, "listRuntimes").mockRejectedValue(new Error("network error"));
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  const { getByText } = render(RuntimesPage);

  await waitFor(() => {
    expect(getByText("network error")).toBeTruthy();
  });
});

test("calls listRuntimes on mount", async () => {
  const spy = vi.spyOn(api, "listRuntimes").mockResolvedValue([]);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({
    providers: ["docker"],
    manifests: [DOCKER_MANIFEST],
  });

  render(RuntimesPage);

  await waitFor(() => {
    expect(spy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Container runtime column
// ---------------------------------------------------------------------------

test("a runtime running under gVisor says so", async () => {
  // The operator needs to see which isolation a runtime actually got. Showing
  // nothing would make a hardened and an unhardened runtime look identical.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-gvisor", name: "hardened", runtime: "runsc" },
  ]);

  const { container } = render(RuntimesPage);
  await waitFor(() => expect(container.textContent).toMatch(/runsc/));
});

test("a runtime with no reported runtime shows none", async () => {
  // Null means "not recorded", not "runc". Printing a default here would be a
  // guess presented as a fact.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-plain", name: "plain", runtime: null },
  ]);

  const { container } = render(RuntimesPage);
  await waitFor(() => expect(container.textContent).toMatch(/plain/));
  expect(container.textContent).not.toMatch(/runsc|runc/);
});

// ---------------------------------------------------------------------------
// Asleep + Wake
// ---------------------------------------------------------------------------

test("an asleep runtime reads as asleep, not broken", async () => {
  // Sleeping is normal and cheap. Showing it as offline or errored would make
  // the substrate's main feature look like a fault.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-sleep", name: "napping", status: "asleep" as never },
  ]);
  const { container } = render(RuntimesPage);
  await waitFor(() => expect(container.textContent).toMatch(/asleep/i));
});

test("an asleep runtime offers Wake", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-sleep", name: "napping", status: "asleep" as never },
  ]);
  const { getByTestId } = render(RuntimesPage);
  await waitFor(() => expect(getByTestId("wake-btn")).toBeTruthy());
});

test("waking calls startRuntime", async () => {
  // To the driver a wake IS a start; reusing that path avoids a second
  // lifecycle route that could drift from it.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-sleep", name: "napping", status: "asleep" as never },
  ]);
  const start = vi.spyOn(api, "startRuntime").mockResolvedValue(undefined as never);

  const { getByTestId } = render(RuntimesPage);
  await waitFor(() => expect(getByTestId("wake-btn")).toBeTruthy());
  fireEvent.click(getByTestId("wake-btn"));

  await waitFor(() => expect(start).toHaveBeenCalledWith("rt-sleep"));
});

// ---------------------------------------------------------------------------
// Starting + why a runtime failed (issue #254)
// ---------------------------------------------------------------------------

test("a starting runtime reads as starting, not online", async () => {
  // The substrate accepting a start request is not a node being connected.
  // Showing green here is what sent an operator restarting a container that
  // was crash-exiting in under a second.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-starting", name: "booting", status: "starting" as never },
  ]);

  const { getByTestId } = render(RuntimesPage);
  await waitFor(() => expect(getByTestId("status-badge").textContent).toContain("starting"));
  // Styled as in-flight, not as running — an unmapped status would render bare.
  expect(getByTestId("status-badge").className).toContain("status-starting");
});

test("a starting runtime offers no Start or Stop, but can still be destroyed", async () => {
  // Nothing to do but wait — except escape, if it never comes back.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-starting", name: "booting", status: "starting" as never },
  ]);

  const { queryByTestId, getByTestId } = render(RuntimesPage);
  await waitFor(() => expect(getByTestId("destroy-btn")).toBeTruthy());
  expect(queryByTestId("start-btn")).toBeNull();
  expect(queryByTestId("stop-btn")).toBeNull();
});

test("a failed runtime shows why it failed", async () => {
  // "error" alone leaves the operator's actual question unanswered. The whole
  // point of the timeout is that the console can say the container never came
  // back, rather than inviting another pointless restart.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    {
      ...mockRuntimes[0]!,
      id: "rt-dead",
      name: "never-returned",
      status: "error" as const,
      statusReason: "no node enrolled within 2m of the start request — the container was asked to run but never came back",
    },
  ]);

  const { container } = render(RuntimesPage);
  await waitFor(() => expect(container.textContent).toMatch(/no node enrolled/));
});

test("a healthy runtime shows no reason line", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-ok", name: "fine", statusReason: null },
  ]);

  const { queryByTestId, getByText } = render(RuntimesPage);
  await waitFor(() => expect(getByText("fine")).toBeTruthy());
  expect(queryByTestId("status-reason")).toBeNull();
});

// ---------------------------------------------------------------------------
// Stopping + whether a stop was actually confirmed (sibling of #254)
// ---------------------------------------------------------------------------

test("a stopping runtime reads as stopping, not stopped", async () => {
  // `stopped` is what an operator reads as "this has stopped costing me
  // money". Until the substrate confirms the container is down, the console
  // must not say it — and an unmapped status would render as bare text.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-stopping", name: "winding-down", status: "stopping" as never },
  ]);

  const { getByTestId } = render(RuntimesPage);
  await waitFor(() => expect(getByTestId("status-badge").textContent).toContain("stopping"));
  // Styled as in-flight, like `starting` — the same "ask sent, not yet true".
  expect(getByTestId("status-badge").className).toContain("status-starting");
});

test("a stopping runtime offers no Start or Stop, but can still be destroyed", async () => {
  // Stopping it again is meaningless and starting it mid-stop is a race.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-stopping", name: "winding-down", status: "stopping" as never },
  ]);

  const { queryByTestId, getByTestId } = render(RuntimesPage);
  await waitFor(() => expect(getByTestId("destroy-btn")).toBeTruthy());
  expect(queryByTestId("start-btn")).toBeNull();
  expect(queryByTestId("stop-btn")).toBeNull();
});

test("a stop that was never confirmed says so instead of showing a clean stopped", async () => {
  // The whole point: an operator who stops a runtime and sees a bare `stopped`
  // walks away believing the meter stopped. This one is told it did not.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    {
      ...mockRuntimes[0]!,
      id: "rt-unconfirmed",
      name: "maybe-still-billing",
      status: "error" as const,
      statusReason:
        "the stop was not confirmed within 5m: the cloudflare substrate still reports it running — it may still be billing",
    },
  ]);

  const { container } = render(RuntimesPage);
  await waitFor(() => expect(container.textContent).toMatch(/stop was not confirmed/));
  expect(container.textContent).toMatch(/still be billing/);
});

test("a stop nobody could verify is stopped, with the caveat attached", async () => {
  // A driver that cannot report container state gets `stopped` — stranding it
  // in `stopping` forever would be its own lie — but never a silent one.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    {
      ...mockRuntimes[0]!,
      id: "rt-unverified",
      name: "probably-off",
      status: "stopped" as const,
      statusReason: "unverified: the docker driver cannot report container state",
    },
  ]);

  const { getByTestId } = render(RuntimesPage);
  await waitFor(() => expect(getByTestId("status-badge").textContent).toContain("stopped"));
  expect(getByTestId("status-reason").textContent).toMatch(/unverified/);
});

test("an online runtime offers no Wake", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...mockRuntimes[0]!, id: "rt-up", name: "awake", status: "online" as const },
  ]);
  const { queryByTestId, getByText } = render(RuntimesPage);
  await waitFor(() => expect(getByText("awake")).toBeTruthy());
  expect(queryByTestId("wake-btn")).toBeNull();
});
