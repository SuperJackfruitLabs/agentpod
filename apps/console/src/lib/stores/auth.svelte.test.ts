/**
 * auth.svelte.test.ts
 *
 * TDD tests for the web-based auth store (Better Auth cookie session, no Tauri).
 */

import { vi, test, expect, beforeEach, afterEach, describe } from "vitest";
import * as plane from "$lib/auth/org-plane";
import * as staticAuth from "./auth.svelte";
import * as myGrant from "$lib/api/my-grant";

// ---------------------------------------------------------------------------
// Hoist mock objects so they are available inside vi.mock factory closures
// ---------------------------------------------------------------------------

const { mockAuthClient } = vi.hoisted(() => ({
  mockAuthClient: {
    getSession: vi.fn(),
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
  },
}));

// Mock better-auth/svelte so createAuthClient returns our mockAuthClient
vi.mock("better-auth/svelte", () => ({
  createAuthClient: vi.fn(() => mockAuthClient),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Import a fresh copy of the auth store (resets all module-level $state). */
async function freshAuthStore() {
  vi.resetModules();
  // Re-apply mocks after reset so dynamic import picks them up
  vi.mock("better-auth/svelte", () => ({
    createAuthClient: vi.fn(() => mockAuthClient),
  }));
  return import("./auth.svelte");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset all mock call history and return values
  mockAuthClient.getSession.mockReset();
  mockAuthClient.signIn.email.mockReset();
  mockAuthClient.signUp.email.mockReset();
  mockAuthClient.signOut.mockReset();
});

// ---------------------------------------------------------------------------
// initAuth — no client configured yet → no-op (graceful), isInitialized stays false
// ---------------------------------------------------------------------------

test("initAuth with no API URL configured → no-op, stays unauthenticated, isInitialized=false", async () => {
  const { initAuth, auth } = await freshAuthStore();

  // Don't call setAuthApiUrl — client is not configured
  await initAuth();

  expect(auth.isAuthenticated).toBe(false);
  // isInitialized must remain false so a later call (after setAuthApiUrl) can proceed
  expect(auth.isInitialized).toBe(false);
  // getSession should NOT be called when there is no client
  expect(mockAuthClient.getSession).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// initAuth — re-callable: second call AFTER setAuthApiUrl restores session
// ---------------------------------------------------------------------------

test("initAuth called before client ready, then again after setAuthApiUrl → session restored", async () => {
  mockAuthClient.getSession.mockResolvedValue({
    data: {
      user: {
        id: "user-retry",
        email: "retry@example.com",
        name: "Retry User",
        image: null,
      },
      session: {},
    },
  });

  const { setAuthApiUrl, initAuth, auth } = await freshAuthStore();

  // First call with no client — should be a no-op, isInitialized stays false
  await initAuth();
  expect(auth.isInitialized).toBe(false);
  expect(auth.isAuthenticated).toBe(false);
  expect(mockAuthClient.getSession).not.toHaveBeenCalled();

  // Now the connection is established — configure the client and call again
  setAuthApiUrl("http://localhost:3001");
  await initAuth();

  // Second call should have restored the session
  expect(mockAuthClient.getSession).toHaveBeenCalledOnce();
  expect(auth.isAuthenticated).toBe(true);
  expect(auth.user?.id).toBe("user-retry");
  expect(auth.isInitialized).toBe(true);
});

// ---------------------------------------------------------------------------
// initAuth — with client configured, session exists
// ---------------------------------------------------------------------------

test("initAuth with configured client and active session → isAuthenticated true", async () => {
  mockAuthClient.getSession.mockResolvedValue({
    data: {
      user: {
        id: "user-abc",
        email: "alice@example.com",
        name: "Alice",
        image: null,
      },
      session: {},
    },
  });

  const { setAuthApiUrl, initAuth, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");

  await initAuth();

  expect(mockAuthClient.getSession).toHaveBeenCalledOnce();
  expect(auth.isAuthenticated).toBe(true);
  expect(auth.user?.id).toBe("user-abc");
  expect(auth.user?.email).toBe("alice@example.com");
  expect(auth.isInitialized).toBe(true);
});

// ---------------------------------------------------------------------------
// initAuth — with client configured, no session
// ---------------------------------------------------------------------------

test("initAuth with configured client but no session → stays unauthenticated", async () => {
  mockAuthClient.getSession.mockResolvedValue({ data: null });

  const { setAuthApiUrl, initAuth, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");

  await initAuth();

  expect(auth.isAuthenticated).toBe(false);
  expect(auth.isInitialized).toBe(true);
});

// ---------------------------------------------------------------------------
// initAuth — idempotent (second call is a no-op)
// ---------------------------------------------------------------------------

test("initAuth called twice → getSession called only once", async () => {
  mockAuthClient.getSession.mockResolvedValue({ data: null });

  const { setAuthApiUrl, initAuth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");

  await initAuth();
  await initAuth();

  expect(mockAuthClient.getSession).toHaveBeenCalledOnce();
});

// ---------------------------------------------------------------------------
// loginWithEmail — success
// ---------------------------------------------------------------------------

test("loginWithEmail success → isAuthenticated true", async () => {
  mockAuthClient.signIn.email.mockResolvedValue({
    data: {
      user: {
        id: "user-xyz",
        email: "bob@example.com",
        name: "Bob",
        image: null,
      },
      token: "tok-abc",
    },
    error: null,
  });

  const { setAuthApiUrl, loginWithEmail, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");

  const result = await loginWithEmail("bob@example.com", "secret");

  expect(result).toBe(true);
  expect(auth.isAuthenticated).toBe(true);
  expect(auth.user?.email).toBe("bob@example.com");
});

// ---------------------------------------------------------------------------
// loginWithEmail — failure
// ---------------------------------------------------------------------------

test("loginWithEmail with error response → returns false, stays unauthenticated", async () => {
  mockAuthClient.signIn.email.mockResolvedValue({
    data: null,
    error: { message: "Invalid credentials", status: 401 },
  });

  const { setAuthApiUrl, loginWithEmail, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");

  const result = await loginWithEmail("bad@example.com", "wrong");

  expect(result).toBe(false);
  expect(auth.isAuthenticated).toBe(false);
});

// ---------------------------------------------------------------------------
// signUp — success
// ---------------------------------------------------------------------------

test("signUp success → isAuthenticated true", async () => {
  mockAuthClient.signUp.email.mockResolvedValue({
    data: {
      user: {
        id: "user-new",
        email: "carol@example.com",
        name: "Carol",
        image: null,
      },
      token: "tok-new",
    },
    error: null,
  });

  const { setAuthApiUrl, signUp, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");

  const result = await signUp("carol@example.com", "password1", "Carol");

  expect(result).toBe(true);
  expect(auth.isAuthenticated).toBe(true);
  expect(auth.user?.name).toBe("Carol");
});

// ---------------------------------------------------------------------------
// logout — calls signOut, clears session
// ---------------------------------------------------------------------------

test("logout → signOut called, isAuthenticated false", async () => {
  // Establish a session first via loginWithEmail
  mockAuthClient.signIn.email.mockResolvedValue({
    data: {
      user: { id: "u1", email: "dave@example.com", name: "Dave", image: null },
      token: "t1",
    },
    error: null,
  });
  mockAuthClient.signOut.mockResolvedValue({ data: null, error: null });

  const { setAuthApiUrl, loginWithEmail, logout, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");

  await loginWithEmail("dave@example.com", "pass");
  expect(auth.isAuthenticated).toBe(true);

  await logout();

  expect(mockAuthClient.signOut).toHaveBeenCalledOnce();
  expect(auth.isAuthenticated).toBe(false);
});

// ---------------------------------------------------------------------------
// role mapping — initAuth, loginWithEmail, signUp
// ---------------------------------------------------------------------------

test("initAuth: session with role='admin' → auth.user.role === 'admin'", async () => {
  mockAuthClient.getSession.mockResolvedValue({
    data: {
      user: {
        id: "user-admin",
        email: "admin@example.com",
        name: "Admin",
        image: null,
        role: "admin",
      },
      session: {},
    },
  });

  const { setAuthApiUrl, initAuth, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");
  await initAuth();

  expect(auth.user?.role).toBe("admin");
});

test("initAuth: session without role → auth.user.role is null", async () => {
  mockAuthClient.getSession.mockResolvedValue({
    data: {
      user: {
        id: "user-norole",
        email: "norole@example.com",
        name: "NoRole",
        image: null,
        // role intentionally omitted
      },
      session: {},
    },
  });

  const { setAuthApiUrl, initAuth, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");
  await initAuth();

  expect(auth.user?.role).toBeNull();
});

test("loginWithEmail: response with role='admin' → auth.user.role === 'admin'", async () => {
  mockAuthClient.signIn.email.mockResolvedValue({
    data: {
      user: {
        id: "user-login-admin",
        email: "admin@example.com",
        name: "Admin",
        image: null,
        role: "admin",
      },
      token: "tok",
    },
    error: null,
  });

  const { setAuthApiUrl, loginWithEmail, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");
  await loginWithEmail("admin@example.com", "pass");

  expect(auth.user?.role).toBe("admin");
});

test("loginWithEmail: response without role → auth.user.role is null (no crash)", async () => {
  mockAuthClient.signIn.email.mockResolvedValue({
    data: {
      user: {
        id: "user-login-norole",
        email: "user@example.com",
        name: "User",
        image: null,
      },
      token: "tok",
    },
    error: null,
  });

  const { setAuthApiUrl, loginWithEmail, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");
  await loginWithEmail("user@example.com", "pass");

  expect(auth.user?.role).toBeNull();
});

test("signUp: response with role='admin' → auth.user.role === 'admin'", async () => {
  mockAuthClient.signUp.email.mockResolvedValue({
    data: {
      user: {
        id: "user-signup-admin",
        email: "first@example.com",
        name: "First",
        image: null,
        role: "admin",
      },
      token: "tok",
    },
    error: null,
  });

  const { setAuthApiUrl, signUp, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");
  await signUp("first@example.com", "pass", "First");

  expect(auth.user?.role).toBe("admin");
});

test("signUp: response without role → auth.user.role is null (no crash)", async () => {
  mockAuthClient.signUp.email.mockResolvedValue({
    data: {
      user: {
        id: "user-signup-norole",
        email: "new@example.com",
        name: "New",
        image: null,
      },
      token: "tok",
    },
    error: null,
  });

  const { setAuthApiUrl, signUp, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");
  await signUp("new@example.com", "pass", "New");

  expect(auth.user?.role).toBeNull();
});

// ---------------------------------------------------------------------------
// clearAuthSession — resets session + isInitialized (used on disconnect/switch)
// ---------------------------------------------------------------------------

test("clearAuthSession → unauthenticated and isInitialized reset to false", async () => {
  mockAuthClient.getSession.mockResolvedValue({
    data: {
      user: { id: "u-clear", email: "eve@example.com", name: "Eve", image: null },
      session: {},
    },
  });

  const { setAuthApiUrl, initAuth, clearAuthSession, auth } = await freshAuthStore();
  setAuthApiUrl("http://localhost:3001");
  await initAuth();
  expect(auth.isAuthenticated).toBe(true);
  expect(auth.isInitialized).toBe(true);

  clearAuthSession();

  expect(auth.isAuthenticated).toBe(false);
  // isInitialized reset so a fresh setAuthApiUrl + initAuth restores cleanly
  expect(auth.isInitialized).toBe(false);
});

// ---------------------------------------------------------------------------
// Under the org plane (P3 Task 14): /api/me with the plane token, never Better Auth
// ---------------------------------------------------------------------------

describe("under the org plane", () => {
  const P = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.test" };
  const { setPlane, initAuth, auth, logout, getToken, clearAuthSession, setAuthApiUrl, resetAuthInit } = staticAuth;

  beforeEach(() => {
    clearAuthSession();
    setAuthApiUrl("https://hub.test");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearAuthSession();
  });

  test("initAuth restores the user from /api/me with the plane token, never Better Auth", async () => {
    setPlane(P);
    vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "prn_hhhhhhhhhhhhhhhhhhhh", email: "op@example.com", isAdmin: true, issuer: "org-plane" }), { status: 200 }),
    );
    await initAuth();
    expect(fetchSpy).toHaveBeenCalledWith("https://hub.test/api/me", expect.objectContaining({ headers: { Authorization: "Bearer at1" } }));
    expect(auth.user?.role).toBe("admin");
    expect(auth.user?.id).toBe("prn_hhhhhhhhhhhhhhhhhhhh");
    expect(auth.isInitialized).toBe(true);
    expect(mockAuthClient.getSession).not.toHaveBeenCalled();
  });

  test("no token in memory (a reload) leaves the user signed out and asks nobody", async () => {
    setPlane(P);
    vi.spyOn(plane, "planeAccessToken").mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await initAuth();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.isInitialized).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockAuthClient.getSession).not.toHaveBeenCalled();
  });

  test("a hub that refuses the token signs out locally, so the guard cannot loop on a silent re-authorize", async () => {
    setPlane(P);
    vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
    const out = vi.spyOn(plane, "signOutLocal");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "product_not_enabled", org: "org_x" }), { status: 403 }),
    );
    await initAuth();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.error).toMatch(/403/);
    expect(out).toHaveBeenCalled();
  });

  test("a hub that refuses the token also stops automatic sign-in for this page load (no loop)", async () => {
    setPlane(P);
    vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
    const suppress = vi.spyOn(plane, "suppressAutoSignIn");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 403 }));
    await initAuth();
    expect(suppress).toHaveBeenCalled();
  });

  test("planeSessionLost (a 401) forgets the user only once no tokens remain, and is not a sign-out", async () => {
    setPlane(P);
    vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "prn_x", email: "op@example.com", isAdmin: false }), { status: 200 }),
    );
    await initAuth();
    expect(auth.isAuthenticated).toBe(true);
    const discard = vi.spyOn(plane, "discardToken");
    const signOutSpy = vi.spyOn(plane, "signOut");
    const held = vi.spyOn(plane, "hasTokens").mockReturnValue(true);
    staticAuth.planeSessionLost(null);
    expect(discard).toHaveBeenCalledWith(null);
    expect(auth.isAuthenticated).toBe(true); // a refresh token is still held: not lost yet
    held.mockReturnValue(false);
    staticAuth.planeSessionLost("at1");
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.isInitialized).toBe(true); // the guard decides now, and re-authorizes
    expect(signOutSpy).not.toHaveBeenCalled();
    expect(staticAuth.currentPlane()).toEqual(P); // unlike clearAuthSession, the plane is kept
  });

  test("resetAuthInit lets initAuth run again after the callback", async () => {
    setPlane(P);
    const tok = vi.spyOn(plane, "planeAccessToken").mockResolvedValue(null);
    await initAuth();
    await initAuth();
    expect(tok).toHaveBeenCalledTimes(1);
    resetAuthInit();
    await initAuth();
    expect(tok).toHaveBeenCalledTimes(2);
  });

  test("getToken returns the plane token; logout revokes at the plane and forgets locally", async () => {
    setPlane(P);
    vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
    const out = vi.spyOn(plane, "signOut").mockResolvedValue();
    expect(await getToken()).toBe("at1");
    await logout();
    expect(out).toHaveBeenCalledWith(P); // signOut clears memory first, then revokes (finding 7a)
    expect(mockAuthClient.signOut).not.toHaveBeenCalled();
  });

  test("clearAuthSession (switching hubs) forgets the plane and its tokens", async () => {
    setPlane(P);
    const out = vi.spyOn(plane, "signOutLocal");
    clearAuthSession();
    expect(staticAuth.currentPlane()).toBeNull();
    expect(out).toHaveBeenCalled();
  });

  test("getToken(minValiditySec) passes the floor to the plane", async () => {
    setPlane({ issuer: "i", url: "u", audience: "a" });
    const spy = vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
    await getToken(60);
    expect(spy).toHaveBeenCalledWith({ issuer: "i", url: "u", audience: "a" }, { minValiditySec: 60 });
  });

  test("logout forgets the cached reach answer (it belonged to the user who left)", async () => {
    setPlane(P);
    const forget = vi.spyOn(myGrant, "forgetMyReach");
    await logout();
    expect(forget).toHaveBeenCalled();
  });

  test("legacy logout forgets the cached reach answer too", async () => {
    setPlane(null);
    mockAuthClient.signOut.mockResolvedValue({});
    const forget = vi.spyOn(myGrant, "forgetMyReach");
    await logout();
    expect(forget).toHaveBeenCalled();
  });

  test("legacy mode: getToken is still null", async () => {
    setPlane(null);
    expect(await getToken()).toBeNull();
  });
});
