/**
 * Bearer-token check for every route except /health.
 *
 * The worker can start containers that enrol into a fleet, so an unauthenticated
 * caller could mint stations. /health is exempt so the driver can fail fast on a
 * misconfigured URL without holding a credential.
 */
export function isAuthorised(request: Request, expected: string | undefined): boolean {
  return tokenMatches(bearerToken(request), expected);
}

/** The bearer token presented on a request, or null when absent/malformed. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  return header.slice(prefix.length);
}

/**
 * Compare a presented token against an expected one, failing closed.
 *
 * Shared by the admin gate and the per-sandbox snapshot gate so both inherit
 * the same two properties: an unset expected value refuses everything, and the
 * comparison does not leak length-independent timing.
 */
export function tokenMatches(presented: string | null, expected: string | undefined): boolean {
  if (!expected) return false; // no secret configured → refuse everything
  if (presented === null) return false;
  return timingSafeEqual(presented, expected);
}

/** Constant-time compare, so a wrong token cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
