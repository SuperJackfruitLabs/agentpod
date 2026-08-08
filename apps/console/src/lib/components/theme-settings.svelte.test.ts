/**
 * theme-settings.svelte.test.ts
 *
 * TDD tests for the restyled ThemeSettings component.
 * RED → restyle theme-settings.svelte → GREEN.
 *
 * Asserts:
 *  - Renders the four color-mode options (Light/Dark/System/Auto)
 *  - Clicking a mode option calls themeStore.setMode with that mode's value
 *  - Deleting a saved custom theme opens a confirm dialog and only calls
 *    themeStore.deleteCustomTheme after the user confirms
 */

import { test, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";

// ---------------------------------------------------------------------------
// Theme store mock — mirrors the shape used by the settings page test.
// ---------------------------------------------------------------------------

const { customTheme, themeStoreMock } = vi.hoisted(() => {
  const customTheme = {
    id: "ct1",
    name: "My Custom Theme",
    colorSchemeId: "default",
    fontPairingId: "default",
    createdAt: 0,
    updatedAt: 0,
  };

  const themeStoreMock = {
    mode: "system" as const,
    resolvedMode: "dark" as const,
    colorSchemeId: "default",
    fontPairingId: "default",
    autoSchedule: { darkStartHour: 18, darkEndHour: 6 },
    currentColorScheme: null,
    currentFontPairing: null,
    customThemes: [customTheme],
    shikiThemes: { light: "github-light", dark: "github-dark" },
    setMode: vi.fn(),
    setColorScheme: vi.fn(),
    setFontPairing: vi.fn(),
    saveCustomTheme: vi.fn(),
    deleteCustomTheme: vi.fn(),
    applyCustomTheme: vi.fn(),
    getColorSchemePreview: vi.fn(() => ({ background: "#000", primary: "#fff", foreground: "#ccc" })),
  };

  return { customTheme, themeStoreMock };
});

vi.mock("$lib/themes/store.svelte", () => ({
  themeStore: themeStoreMock,
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

import ThemeSettings from "./theme-settings.svelte";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renders the four color-mode options", () => {
  const { getByText } = render(ThemeSettings);
  expect(getByText("Light")).toBeTruthy();
  expect(getByText("Dark")).toBeTruthy();
  expect(getByText("System")).toBeTruthy();
  expect(getByText("Auto")).toBeTruthy();
});

test("clicking a mode option calls themeStore.setMode with that mode", async () => {
  const { getByText } = render(ThemeSettings);
  await fireEvent.click(getByText("Light"));
  expect(themeStoreMock.setMode).toHaveBeenCalledWith("light");
});

test("deleting a custom theme opens a confirm dialog and only deletes after confirming", async () => {
  const { getByTestId, getByText, queryByText } = render(ThemeSettings);

  await fireEvent.click(getByTestId(`delete-theme-${customTheme.id}`));

  // Confirm dialog appears (bits-ui Dialog portals async) and delete has not
  // happened yet.
  await waitFor(() => {
    expect(queryByText("Delete theme")).toBeTruthy();
  });
  expect(themeStoreMock.deleteCustomTheme).not.toHaveBeenCalled();

  // Confirming triggers the delete.
  const confirmBtn = getByText("Delete", { selector: "button" });
  expect(confirmBtn.className).toContain("bg-destructive");
  await fireEvent.click(confirmBtn);

  expect(themeStoreMock.deleteCustomTheme).toHaveBeenCalledWith(customTheme.id);
});
