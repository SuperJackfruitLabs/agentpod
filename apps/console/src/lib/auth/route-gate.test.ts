import { expect, test } from "vitest";
import { showConnecting } from "./route-gate";

const base = { isInitializing: false, autoSigningIn: false, isPublicRoute: false, isAuthenticated: true };

test("a signed-in visitor gets the route", () => {
  expect(showConnecting(base)).toBe(false);
});

test("a protected route is not mounted before the session is re-established", () => {
  // initAuth has finished, signed out (full load, token memory-only); the guard's effect has not
  // started the silent sign-in yet. The route used to mount here and fire bare requests.
  expect(showConnecting({ ...base, isAuthenticated: false })).toBe(true);
});

test("still initialising or signing in silently: connecting", () => {
  expect(showConnecting({ ...base, isInitializing: true })).toBe(true);
  expect(showConnecting({ ...base, autoSigningIn: true })).toBe(true);
});

test("/login and /auth/callback render signed out", () => {
  expect(showConnecting({ ...base, isPublicRoute: true, isAuthenticated: false })).toBe(false);
});
