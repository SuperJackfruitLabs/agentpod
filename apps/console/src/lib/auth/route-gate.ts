/**
 * Whether the root layout shows the "Connecting…" screen instead of the route.
 *
 * A protected route is not mounted until someone is signed in. Under the plane a full page load
 * starts signed out (the token is memory-only) and the guard re-authorizes; mounting the route in
 * that window let its onMount fire bare hub requests (a node page stuck on "Couldn't reach the
 * hub") and let the admin guard send the person to /login (staging, 2026-10-22).
 */
export function showConnecting(s: {
  isInitializing: boolean;
  autoSigningIn: boolean;
  isPublicRoute: boolean;
  isAuthenticated: boolean;
}): boolean {
  if (s.isInitializing || s.autoSigningIn) return true;
  return !s.isPublicRoute && !s.isAuthenticated;
}
