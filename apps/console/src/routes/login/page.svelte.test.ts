/**
 * page.svelte.test.ts
 *
 * TDD tests for the restyled login page.
 * RED → implement +page.svelte → GREEN.
 *
 * Asserts:
 *  - Disconnected → shows the connect (setup) form: Hub URL field + Connect button
 *  - Connected → shows the sign-in form, and toggling switches to signup (Name field appears)
 *  - Connected + signup disabled → toggle is blocked and the disabled message is shown
 */

import { test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fleet store mocks — mutable so each test can flip connection/auth state.
// Hoisted so the factory closures below (which vitest hoists above all
// other module code, including these const declarations) can reference them.
// ---------------------------------------------------------------------------

const { authState, connectionState } = vi.hoisted(() => ({
  authState: {
    user: null as { id: string; email: string; name?: string | null } | null,
    isAuthenticated: false,
    isLoading: false,
    isInitialized: true,
    error: null as string | null,
  },
  connectionState: {
    apiUrl: null as string | null,
    isConnected: false,
    isLoading: false,
    isInitialized: true,
    error: null as string | null,
  },
}));

vi.mock("$lib/stores/auth.svelte", () => ({
  auth: authState,
  loginWithEmail: vi.fn(),
  signUp: vi.fn(),
  clearError: vi.fn(),
  initAuth: vi.fn(),
}));

vi.mock("$lib/stores/connection.svelte", () => ({
  connection: connectionState,
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

// ---------------------------------------------------------------------------
// signup-status probe — the login page hits this directly via fetch,
// bypassing the auth client since there's no session yet.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ---------------------------------------------------------------------------
// Static import — compiled once after all mocks are registered
// ---------------------------------------------------------------------------

import LoginPage from "./+page.svelte";

beforeEach(() => {
  authState.user = null;
  authState.isAuthenticated = false;
  authState.isLoading = false;
  authState.error = null;

  connectionState.apiUrl = null;
  connectionState.isConnected = false;
  connectionState.error = null;

  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ enabled: true, message: null }),
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("disconnected shows the connect form", () => {
  const { getByLabelText, getByRole } = render(LoginPage);
  expect(getByLabelText("Hub URL")).toBeTruthy();
  expect(getByRole("button", { name: "Connect" })).toBeTruthy();
});

test("connected shows the sign-in form, and toggling reveals the Name field", async () => {
  connectionState.isConnected = true;
  connectionState.apiUrl = "https://hub.x";

  const { getByLabelText, getByRole, queryByLabelText } = render(LoginPage);

  expect(getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(getByLabelText("Email")).toBeTruthy();
  expect(queryByLabelText("Name")).toBeNull();

  await fireEvent.click(getByRole("button", { name: "Create one" }));

  expect(getByLabelText("Name")).toBeTruthy();
  expect(getByRole("button", { name: "Create account" })).toBeTruthy();
});

test("connected + signup disabled blocks the toggle and shows the disabled message", async () => {
  connectionState.isConnected = true;
  connectionState.apiUrl = "https://hub.x";
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ enabled: false, message: "Public registration is disabled." }),
  });

  const { getByText, queryByLabelText, queryByRole } = render(LoginPage);

  await waitFor(() => {
    expect(getByText("Public registration is disabled.")).toBeTruthy();
  });
  expect(queryByRole("button", { name: "Create one" })).toBeNull();
  expect(queryByLabelText("Name")).toBeNull();
});
