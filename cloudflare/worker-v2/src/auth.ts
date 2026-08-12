/**
 * Bearer-token check for every route except /health.
 *
 * The worker can start containers that enrol into a fleet, so an unauthenticated
 * caller could mint stations. /health is exempt so the driver can fail fast on a
 * misconfigured URL without holding a credential.
 */
export function isAuthorised(request: Request, expected: string | undefined): boolean {
  if (!expected) return false; // no secret configured → refuse everything
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}

/** Constant-time compare, so a wrong token cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
