/**
 * TopBar.svelte.test.ts
 *
 * The bar's job beyond chrome: say which hub this console is talking to, and
 * whether that hub is answering.
 */
import { test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";

const { mockConnection, mockAuth, mockPalette, mockLogout, mockGoto } = vi.hoisted(() => ({
  mockConnection: {
    apiUrl: "https://hub.agentpod.dev" as string | null,
    isConnected: true,
    reachable: true,
  },
  mockAuth: { initials: "RG" },
  mockPalette: { toggle: vi.fn() },
  mockLogout: vi.fn(async () => {}),
  mockGoto: vi.fn(async () => {}),
}));

vi.mock("$lib/stores/connection.svelte", () => ({ connection: mockConnection }));
vi.mock("$lib/stores/auth.svelte", () => ({ auth: mockAuth, logout: mockLogout }));
vi.mock("$app/navigation", () => ({ goto: mockGoto }));
vi.mock("$lib/stores/command-palette.svelte", () => ({ commandPalette: mockPalette }));

import TopBar from "./TopBar.svelte";

beforeEach(() => {
  mockConnection.apiUrl = "https://hub.agentpod.dev";
  mockConnection.isConnected = true;
  mockConnection.reachable = true;
  mockAuth.initials = "RG";
  mockPalette.toggle.mockClear();
  mockLogout.mockClear();
  mockGoto.mockClear();
});

test("the bar has a labelled sign-out button that signs out, then goes to /login", async () => {
  const { getByTestId } = render(TopBar);
  const button = getByTestId("topbar-sign-out");

  expect(button.tagName).toBe("BUTTON");
  expect(button.getAttribute("aria-label")).toBe("Sign out");
  await fireEvent.click(button);
  await vi.waitFor(() => expect(mockGoto).toHaveBeenCalledWith("/login"));
  expect(mockLogout).toHaveBeenCalledTimes(1);
  // Signed out first: going to /login with live tokens would bounce straight back in.
  expect(mockLogout.mock.invocationCallOrder[0]).toBeLessThan(mockGoto.mock.invocationCallOrder[0]!);
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

test("the wordmark is the mark and the product's name, leading home", () => {
  const { getByTestId } = render(TopBar);
  const wordmark = getByTestId("wordmark");

  expect(wordmark.textContent?.trim()).toBe("AgentPod");
  expect(wordmark.getAttribute("href")).toBe("/");
  expect(wordmark.querySelector('[data-testid="agentpod-mark"]')).toBeTruthy();
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

test("below 901px, and on any touch screen, every control in the bar is a 44px target", () => {
  // Measured at 390: the controls were 32×32 and the hub pill 78×26
  // (responsive audit, 2026-10-07). 44px is the floor for a fingertip.
  const { getByTestId } = render(TopBar);
  // The palette cue is a wide labelled button on a desktop: it grows taller
  // under a finger, and becomes a 44px square below 901px.
  const cue = getByTestId("palette-cue").className;
  expect(cue).toContain("max-[900px]:size-11");
  expect(cue).toContain("pointer-coarse:h-11");
  for (const id of ["roster-toggle", "appearance-link", "topbar-sign-out"]) {
    const cls = getByTestId(id).className;
    expect(cls, id).toContain("max-[900px]:size-11");
    expect(cls, id).toContain("pointer-coarse:size-11");
  }
  for (const id of ["hub-pill", "wordmark"]) {
    const cls = getByTestId(id).className;
    expect(cls, id).toContain("max-[900px]:min-h-11");
    expect(cls, id).toContain("pointer-coarse:min-h-11");
  }
});
