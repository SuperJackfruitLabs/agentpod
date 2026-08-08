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

import { test, expect, vi } from "vitest";
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
