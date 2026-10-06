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
// ThemeSettings imports the theme store which calls window.matchMedia at
// module-init time — mock the entire store so ThemeSettings renders safely.
// ---------------------------------------------------------------------------

vi.mock("$lib/themes/store.svelte", () => ({
  themeStore: {
    mode: "system",
    resolvedMode: "dark",
    colorSchemeId: "default",
    fontPairingId: "default",
    autoSchedule: { darkStartHour: 18, darkEndHour: 6 },
    currentColorScheme: null,
    currentFontPairing: null,
    customThemes: [],
    shikiThemes: { light: "github-light", dark: "github-dark" },
    setMode: vi.fn(),
    setColorScheme: vi.fn(),
    setFontPairing: vi.fn(),
    saveCustomTheme: vi.fn(),
    deleteCustomTheme: vi.fn(),
    applyCustomTheme: vi.fn(),
    getColorSchemePreview: vi.fn(() => ({ background: "#000", primary: "#fff", foreground: "#ccc" })),
  },
  colorSchemes: [],
  fontPairings: [],
  colorSchemeCategories: [],
  fontPairingCategories: [],
  ThemeMode: {},
  DEFAULT_COLOR_SCHEME_ID: "default",
  DEFAULT_FONT_PAIRING_ID: "default",
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
