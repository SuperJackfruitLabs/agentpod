/**
 * command-palette.svelte.test.ts
 *
 * TDD tests for the Cmd-K fleet command palette.
 * RED → implement command-palette.svelte → GREEN.
 *
 * Asserts:
 *  - commandPalette.open() → search input + static actions render
 *  - listNodes() mock → node item appears; filtering "zzz" hides it
 *  - clicking a node item calls goto("/nodes/<id>")
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
}));

vi.mock("$app/state", () => ({
  page: { url: { pathname: "/" } },
}));

// ---------------------------------------------------------------------------
// API mock
// ---------------------------------------------------------------------------

vi.mock("$lib/api/client", () => ({
  listNodes: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as api from "$lib/api/client";
import * as nav from "$app/navigation";
import { commandPalette } from "$lib/stores/command-palette.svelte";
import CommandPalette from "./command-palette.svelte";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  commandPalette.close();
});

afterEach(cleanup);

const mockNodes = [{ id: "node_1", hostname: "box1" }];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("when open: renders a search input and static actions", async () => {
  vi.mocked(api.listNodes).mockResolvedValue([]);

  commandPalette.open();
  const { getByPlaceholderText, getByText } = render(CommandPalette);

  await waitFor(() => {
    // Search input (bits-ui Command.Input renders role="combobox", not "textbox")
    expect(getByPlaceholderText("Search fleet commands, nodes…")).toBeTruthy();
    // Static actions
    expect(getByText("New runtime")).toBeTruthy();
    expect(getByText("Settings")).toBeTruthy();
  });
});

test("when closed: palette is not visible", async () => {
  vi.mocked(api.listNodes).mockResolvedValue([]);

  commandPalette.close();
  const { queryByPlaceholderText } = render(CommandPalette);

  // The dialog content should not be in the DOM when closed
  expect(queryByPlaceholderText("Search fleet commands, nodes…")).toBeNull();
});

test("node from listNodes appears as an item after open", async () => {
  vi.mocked(api.listNodes).mockResolvedValue(mockNodes as never);

  commandPalette.open();
  const { getByText } = render(CommandPalette);

  await waitFor(() => {
    expect(getByText("box1")).toBeTruthy();
  });
});

test("typing 'zzz' filters out the node item", async () => {
  vi.mocked(api.listNodes).mockResolvedValue(mockNodes as never);

  commandPalette.open();
  const { getByPlaceholderText, queryByText } = render(CommandPalette);

  await waitFor(() => {
    expect(getByPlaceholderText("Search fleet commands, nodes…")).toBeTruthy();
  });

  const input = getByPlaceholderText("Search fleet commands, nodes…");
  await fireEvent.input(input, { target: { value: "zzz" } });

  expect(queryByText("box1")).toBeNull();
});

test("clicking a node item calls goto('/nodes/node_1')", async () => {
  vi.mocked(api.listNodes).mockResolvedValue(mockNodes as never);
  const gotoSpy = vi.mocked(nav.goto);

  commandPalette.open();
  const { getByText } = render(CommandPalette);

  await waitFor(() => {
    expect(getByText("box1")).toBeTruthy();
  });

  fireEvent.click(getByText("box1"));

  expect(gotoSpy).toHaveBeenCalledWith("/nodes/node_1");
});

test("shows a loading affordance while listNodes() is pending, then the Nodes group once it resolves", async () => {
  let resolveNodes!: (nodes: typeof mockNodes) => void;
  const pending = new Promise<typeof mockNodes>((resolve) => {
    resolveNodes = resolve;
  });
  vi.mocked(api.listNodes).mockReturnValue(pending as never);

  commandPalette.open();
  const { getByText, queryByText } = render(CommandPalette);

  // Static actions render instantly; the Nodes section is still pending.
  await waitFor(() => {
    expect(getByText("New runtime")).toBeTruthy();
    expect(getByText("Loading nodes…")).toBeTruthy();
  });
  expect(queryByText("box1")).toBeNull();

  resolveNodes(mockNodes);

  await waitFor(() => {
    expect(getByText("box1")).toBeTruthy();
  });
  expect(queryByText("Loading nodes…")).toBeNull();
});

test("clicking Settings calls goto('/settings')", async () => {
  vi.mocked(api.listNodes).mockResolvedValue([]);
  const gotoSpy = vi.mocked(nav.goto);

  commandPalette.open();
  const { getByText } = render(CommandPalette);

  await waitFor(() => {
    expect(getByText("Settings")).toBeTruthy();
  });

  fireEvent.click(getByText("Settings"));

  expect(gotoSpy).toHaveBeenCalledWith("/settings");
});
