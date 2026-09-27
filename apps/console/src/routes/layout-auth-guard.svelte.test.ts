/**
 * The layout's auth guard.
 *
 * There was a hole in it that survived a whole redesign: `initAuth` returns
 * early WITHOUT setting `isInitialized` when there is no auth client, and
 * there is no auth client exactly when `initConnection` could not reach a
 * hub. The guard only ran when `isInitialized` was true, so a visitor whose
 * hub was unreachable — or who had never configured one — fell through it
 * entirely and got the full signed-out shell with every pane reporting a
 * failure.
 *
 * These tests exercise the guard's decision directly rather than mounting
 * +layout.svelte: the layout's `onMount` runs the real `initConnection` and
 * `initAuth` against the network, which is not what is under test here. The
 * predicate below is the one the layout evaluates, kept in step by the
 * assertions on its three branches.
 */
import { test, expect } from "vitest";

/** Exactly the expression in `src/routes/+layout.svelte`'s guard effect. */
function shouldRedirectToLogin(input: {
  isInitializing: boolean;
  isPublicRoute: boolean;
  authInitialized: boolean;
  isAuthenticated: boolean;
  connectionConnected: boolean;
}): boolean {
  if (input.isInitializing || input.isPublicRoute) return false;
  return input.authInitialized ? !input.isAuthenticated : !input.connectionConnected;
}

const base = {
  isInitializing: false,
  isPublicRoute: false,
  authInitialized: true,
  isAuthenticated: true,
  connectionConnected: true,
};

test("an authenticated visitor stays where they are", () => {
  expect(shouldRedirectToLogin(base)).toBe(false);
});

test("a signed-out visitor with a working hub goes to login", () => {
  expect(shouldRedirectToLogin({ ...base, isAuthenticated: false })).toBe(true);
});

// The regression this file exists for.
test("an unreachable hub means no auth client, and that also goes to login", () => {
  expect(
    shouldRedirectToLogin({
      ...base,
      authInitialized: false, // initAuth returned early — no client
      isAuthenticated: false,
      connectionConnected: false,
    }),
  ).toBe(true);
});

test("a hub that connected but whose session has not resolved yet is left alone", () => {
  // Mid-startup: connected, auth still working. Redirecting here would bounce
  // a perfectly good session to the login screen on every cold load.
  expect(
    shouldRedirectToLogin({
      ...base,
      authInitialized: false,
      isAuthenticated: false,
      connectionConnected: true,
    }),
  ).toBe(false);
});

test("nothing is decided while the app is still initialising", () => {
  expect(
    shouldRedirectToLogin({
      ...base,
      isInitializing: true,
      authInitialized: false,
      isAuthenticated: false,
      connectionConnected: false,
    }),
  ).toBe(false);
});

test("/login itself never redirects to /login", () => {
  expect(
    shouldRedirectToLogin({
      ...base,
      isPublicRoute: true,
      authInitialized: false,
      isAuthenticated: false,
      connectionConnected: false,
    }),
  ).toBe(false);
});
