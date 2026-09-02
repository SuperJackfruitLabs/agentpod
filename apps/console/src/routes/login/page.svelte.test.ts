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

// The one call that leaves this origin, stood in for. `resolveReturnTo` itself is the real one —
// the point of these cases is that the page uses it, and uses its answer correctly.
vi.mock("$lib/utils/return-to", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/utils/return-to")>()),
  hardNavigate: vi.fn(),
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
import { goto } from "$app/navigation";
import { loginWithEmail } from "$lib/stores/auth.svelte";
import { hardNavigate } from "$lib/utils/return-to";

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

  vi.mocked(goto).mockClear();
  vi.mocked(hardNavigate).mockClear();
  vi.mocked(loginWithEmail).mockReset();
  window.history.replaceState({}, "", "/login");
});

/**
 * Sign in on a login page that arrived carrying `redirect`.
 *
 * The hub's `GET /api/auth/authorize` 302s here with that parameter when the operator has no hub
 * session, naming the authorize URL to resume. Before this the page called `goto("/")` regardless,
 * so the cross-domain token flow dead-ended for exactly the person it exists for.
 */
async function signInFrom(search: string) {
  window.history.replaceState({}, "", `/login${search}`);
  connectionState.isConnected = true;
  connectionState.apiUrl = "https://hub.x";
  vi.mocked(loginWithEmail).mockResolvedValue(true);

  const { getByLabelText, getByRole } = render(LoginPage);
  await fireEvent.input(getByLabelText("Email"), { target: { value: "a@b.c" } });
  await fireEvent.input(getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
  await fireEvent.submit(getByRole("button", { name: "Sign in" }).closest("form")!);
  await waitFor(() => expect(vi.mocked(loginWithEmail)).toHaveBeenCalled());
}

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

test("no return parameter still lands on the console home", async () => {
  await signInFrom("");
  await waitFor(() => expect(vi.mocked(goto)).toHaveBeenCalledWith("/"));
  expect(vi.mocked(hardNavigate)).not.toHaveBeenCalled();
});

test("a hub-origin authorize URL is resumed after signing in", async () => {
  // The flow this whole spec exists for: the operator was sent here BY the hub, mid-handoff, and
  // has to end up back at the authorize endpoint rather than on the console home.
  const authorize =
    "https://hub.x/api/auth/authorize?client=kaambaan&state=abc&code_challenge_method=S256";
  await signInFrom(`?redirect=${encodeURIComponent(authorize)}`);

  // A real browser navigation, not `goto` — SvelteKit's goto refuses to leave the origin.
  await waitFor(() => expect(vi.mocked(hardNavigate)).toHaveBeenCalledWith(authorize));
  expect(vi.mocked(goto)).not.toHaveBeenCalled();
});

test("an off-origin return goes home, never to the attacker", async () => {
  // A login page that forwards anywhere after authenticating is a phishing gadget. The assertion
  // that matters is the second one: not merely that we went home, but that we never went there.
  await signInFrom(`?redirect=${encodeURIComponent("https://evil.example/steal")}`);

  await waitFor(() => expect(vi.mocked(goto)).toHaveBeenCalledWith("/"));
  expect(vi.mocked(hardNavigate)).not.toHaveBeenCalled();
});
