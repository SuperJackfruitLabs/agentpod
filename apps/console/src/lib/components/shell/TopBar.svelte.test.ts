/**
 * TopBar.svelte.test.ts
 *
 * The bar's job beyond chrome: say which hub this console is talking to, and
 * whether that hub is answering.
 */
import { test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";

const { mockConnection, mockAuth, mockPalette } = vi.hoisted(() => ({
  mockConnection: {
    apiUrl: "https://hub.agentpod.dev" as string | null,
    isConnected: true,
    reachable: true,
  },
  mockAuth: { initials: "RG" },
  mockPalette: { toggle: vi.fn() },
}));

vi.mock("$lib/stores/connection.svelte", () => ({ connection: mockConnection }));
vi.mock("$lib/stores/auth.svelte", () => ({ auth: mockAuth }));
vi.mock("$lib/stores/command-palette.svelte", () => ({ commandPalette: mockPalette }));

import TopBar from "./TopBar.svelte";

beforeEach(() => {
  mockConnection.apiUrl = "https://hub.agentpod.dev";
  mockConnection.isConnected = true;
  mockConnection.reachable = true;
  mockAuth.initials = "RG";
  mockPalette.toggle.mockClear();
});

test("the hub pill shows the host of the API url, in mono", () => {
  const { getByTestId } = render(TopBar);
  const host = getByTestId("hub-host");

  expect(host.textContent?.trim()).toBe("hub.agentpod.dev");
  expect(host.className).toContain("font-mono");
});

test("the hub pill shows a port when the hub has one — localhost:3001 must not read as a working hub", () => {
  mockConnection.apiUrl = "http://localhost:3001";
  const { getByTestId } = render(TopBar);

  expect(getByTestId("hub-host").textContent?.trim()).toBe("localhost:3001");
});

test("the hub pill leads to settings, where the hub can be changed", () => {
  const { getByTestId } = render(TopBar);

  expect(getByTestId("hub-pill").getAttribute("href")).toBe("/settings");
});

test("a reachable hub's dot is running", () => {
  const { getByTestId } = render(TopBar);
  const dot = getByTestId("hub-pill").querySelector("span[aria-hidden]");

  expect(dot?.className).toContain("bg-status-running");
});

test("an unreachable hub's dot is error, and says so in a word", () => {
  mockConnection.reachable = false;
  const { getByTestId } = render(TopBar);
  const pill = getByTestId("hub-pill");

  expect(pill.querySelector("span[aria-hidden]")?.className).toContain("bg-status-error");
  // Constraint 6: never hue alone — StateDot keeps the word for assistive tech.
  expect(pill.querySelector(".sr-only")?.textContent).toBe("Error");
});

test("with no hub configured the pill says so, and the dot is unknown rather than green", () => {
  mockConnection.apiUrl = null;
  mockConnection.isConnected = false;
  const { getByTestId } = render(TopBar);

  expect(getByTestId("hub-host").textContent?.trim()).toBe("No hub");
  expect(getByTestId("hub-pill").querySelector("span[aria-hidden]")?.className).toContain(
    "bg-status-unknown",
  );
});

test("a hub that failed its boot handshake is error, not running", () => {
  // `reachable` starts optimistically true and is only probed while connected,
  // so this is the case where trusting it alone would show a green dot beside
  // a hub the console never reached.
  mockConnection.isConnected = false;
  mockConnection.reachable = true;
  const { getByTestId } = render(TopBar);

  expect(getByTestId("hub-pill").querySelector("span[aria-hidden]")?.className).toContain(
    "bg-status-error",
  );
});

test("a malformed hub url falls back to the raw value instead of throwing", () => {
  mockConnection.apiUrl = "not a url";
  const { getByTestId } = render(TopBar);

  expect(getByTestId("hub-host").textContent?.trim()).toBe("not a url");
});

test("clicking the palette cue toggles the command palette", async () => {
  const { getByTestId } = render(TopBar);

  await fireEvent.click(getByTestId("palette-cue"));

  expect(mockPalette.toggle).toHaveBeenCalledTimes(1);
});

test("the palette cue names both things the palette does", () => {
  const { getByTestId } = render(TopBar);

  expect(getByTestId("palette-cue").textContent).toContain("Message an agent, or run a command");
  expect(getByTestId("palette-cue").textContent).toContain("⌘K");
});

test("the avatar shows the signed-in user's initials", () => {
  mockAuth.initials = "AB";
  const { getByTestId } = render(TopBar);

  expect(getByTestId("user-avatar").textContent?.trim()).toBe("AB");
});

test("the wordmark is present, with · MUSTER as its own element so it can drop out on narrow screens", () => {
  const { getByTestId, getByText } = render(TopBar);

  expect(getByText("AGENTPOD")).toBeTruthy();
  expect(getByTestId("wordmark-suffix").textContent).toContain("MUSTER");
});

test("the roster toggle calls back and is hidden above the one-column breakpoint", async () => {
  const onToggleRoster = vi.fn();
  const { getByTestId } = render(TopBar, { props: { onToggleRoster } });

  await fireEvent.click(getByTestId("roster-toggle"));

  expect(onToggleRoster).toHaveBeenCalledTimes(1);
  expect(getByTestId("roster-toggle").className).toContain("min-[901px]:hidden");
});

test("appearance leads to settings", () => {
  const { getByTestId } = render(TopBar);

  expect(getByTestId("appearance-link").getAttribute("href")).toBe("/settings");
});
