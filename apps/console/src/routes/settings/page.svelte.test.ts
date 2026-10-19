/**
 * page.svelte.test.ts
 *
 * TDD tests for the minimal fleet Settings page.
 * RED → implement +page.svelte → GREEN.
 *
 * Asserts:
 *  - Shows the logged-in user email (a@b.c)
 *  - Shows the hub URL (https://hub.x)
 *  - Shows a "Sign out" control
 */

import { test, expect, vi, beforeEach } from "vitest";

const { planeState } = vi.hoisted(() => ({
  planeState: { value: null as { issuer: string; url: string; audience: string } | null },
}));
import { render } from "@testing-library/svelte";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fleet store mocks
// ---------------------------------------------------------------------------

vi.mock("$lib/stores/auth.svelte", () => ({
  auth: {
    user: { id: "1", email: "a@b.c", name: "A", role: "admin" },
    isAuthenticated: true,
    isLoading: false,
    isInitialized: true,
    error: null,
    displayName: "A",
    initials: "A",
    avatarUrl: null,
    email: "a@b.c",
  },
  logout: vi.fn(),
  currentPlane: () => planeState.value,
}));

// The device list fetches on mount; stand it in so these cases stay about the page.
vi.mock("$lib/components/device-list.svelte", async () => ({
  default: (await import("./device-list-stub.test-host.svelte")).default,
}));

vi.mock("$lib/stores/connection.svelte", () => ({
  connection: {
    apiUrl: "https://hub.x",
    isConnected: true,
    isLoading: false,
    isInitialized: true,
    error: null,
  },
  disconnect: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Static import — compiled once
// ---------------------------------------------------------------------------

import SettingsPage from "./+page.svelte";

beforeEach(() => {
  planeState.value = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("shows the logged-in user email", () => {
  const { container } = render(SettingsPage);
  expect(container.textContent).toContain("a@b.c");
});

test("shows the hub API URL", () => {
  const { container } = render(SettingsPage);
  expect(container.textContent).toContain("https://hub.x");
});

test("renders a Sign out control", () => {
  const { container } = render(SettingsPage);
  const text = container.textContent ?? "";
  const hasSignOut =
    text.toLowerCase().includes("sign out") ||
    !!container.querySelector('[data-testid="sign-out"]');
  expect(hasSignOut).toBe(true);
});

test("shows a 'Connected to' label for the hub URL", () => {
  const { getByText } = render(SettingsPage);
  expect(getByText("Connected to")).toBeTruthy();
});

test("legacy mode: the device list is shown", () => {
  const { getByTestId, queryByText } = render(SettingsPage);
  expect(getByTestId("device-list-stub")).toBeTruthy();
  expect(queryByText(/managed in your Super Jackfruit account/)).toBeNull();
});

test("under the plane, devices are the plane's: a link instead of the list", () => {
  planeState.value = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.x" };
  const { queryByTestId, getByTestId, getByRole } = render(SettingsPage);
  expect(queryByTestId("device-list-stub")).toBeNull();
  expect(getByTestId("managed-by-plane").textContent?.replace(/\s+/g, " ")).toContain("Devices are managed in your Super Jackfruit account");
  expect(getByRole("link", { name: /Super Jackfruit account/ }).getAttribute("href")).toBe("https://accounts.test");
});

test("Settings has Appearance, Connection, Devices and Account, in that order", () => {
  // Under the plane, so the Devices heading is the page's own (the legacy list draws its own).
  planeState.value = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.x" };
  const { getAllByRole } = render(SettingsPage);
  const sections = getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.trim());
  expect(sections).toEqual(["Appearance", "Connection", "Devices", "Account"]);
});

test("Settings' Appearance is the vibekit control (vibe, light or dark, accent), no theme picker", () => {
  const { getByRole, queryByText } = render(SettingsPage);
  expect(getByRole("group", { name: "Vibe" })).toBeTruthy();
  expect(getByRole("group", { name: "Light or dark" })).toBeTruthy();
  expect(getByRole("group", { name: "Accent" })).toBeTruthy();
  expect(queryByText(/colou?r scheme|font pairing/i)).toBeNull();
});
