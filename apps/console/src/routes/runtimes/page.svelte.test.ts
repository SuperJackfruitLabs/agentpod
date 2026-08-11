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
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

  const { container } = render(RuntimesPage);

  await waitFor(() => {
    expect(container.textContent).toContain("Runtimes");
  });
});

test("renders runtime rows with name, provider, and status after loading", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

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
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

  const { getByText } = render(RuntimesPage);

  await waitFor(() => {
    expect(getByText("docker")).toBeTruthy();
    expect(getByText("cloudflare")).toBeTruthy();
  });
});

test("Node column links to the node when present, shows a dash otherwise", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

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
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

  const { getAllByText, getAllByTestId } = render(RuntimesPage);

  await waitFor(() => {
    expect(getAllByTestId("runtime-row").length).toBe(2);
  });

  // Both fixtures share the same createdAt (5 minutes ago) → two "5m ago" cells
  expect(getAllByText("5m ago").length).toBe(2);
});

test("shows Stop button for online runtime and Start button for stopped runtime", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

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
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

  const { getAllByTestId } = render(RuntimesPage);

  await waitFor(() => {
    const destroyBtns = getAllByTestId("destroy-btn");
    expect(destroyBtns.length).toBe(2); // both runtimes qualify
  });
});

test("clicking Destroy opens type-to-confirm dialog; typing the runtime name and confirming calls destroyRuntime", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue(mockRuntimes);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });
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
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

  const { getByTestId } = render(RuntimesPage);

  await waitFor(() => {
    const emptyState = getByTestId("empty-state");
    expect(emptyState.textContent).toContain("No runtimes yet");
  });
});

test("shows empty state CTA button", async () => {
  vi.spyOn(api, "listRuntimes").mockResolvedValue([]);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

  const { getByTestId } = render(RuntimesPage);

  await waitFor(() => {
    const ctaBtn = getByTestId("empty-new-runtime-btn");
    expect(ctaBtn).toBeTruthy();
  });
});

test("shows error message when listRuntimes rejects", async () => {
  vi.spyOn(api, "listRuntimes").mockRejectedValue(new Error("network error"));
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

  const { getByText } = render(RuntimesPage);

  await waitFor(() => {
    expect(getByText("network error")).toBeTruthy();
  });
});

test("calls listRuntimes on mount", async () => {
  const spy = vi.spyOn(api, "listRuntimes").mockResolvedValue([]);
  vi.spyOn(api, "listRuntimeProviders").mockResolvedValue({ providers: ["docker"] });

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
