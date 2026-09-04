/**
 * Strip credentials out of a request log line.
 *
 * The homeserver authenticates its appservice transactions with the token as a **URL query
 * parameter** — `PUT /_matrix/app/v1/transactions/xyz?access_token=…` — and Hono's `logger()`
 * prints the whole path. So every transaction wrote a live appservice credential into journald
 * in clear, at a rate of one line per Matrix event, for as long as the bridge has existed.
 *
 * That token can act as any user inside the appservice's namespace. It was recorded in the
 * estate's backlog on 2026-09-01 with the note that **rotation alone does not close it** — the
 * next token lands in the log the same way. This is the half that does: redact at the point of
 * logging, so the recurrence stops rather than the current value being replaced.
 *
 * Not only the appservice token. `authMiddleware` reads `c.req.query("token")` as a bearer
 * fallback, and the cross-domain handoff (agentpod#406) puts a one-time `code` in a redirect
 * that comes back as a query parameter. Both are credentials, both arrive in URLs, and both
 * were being logged.
 *
 * **Deny-list, not allow-list, and that is a deliberate weakness.** An allow-list of safe
 * parameters would be stronger and would also redact half of every useful debugging line. The
 * mitigation is that adding a credential-bearing query parameter to this codebase means adding
 * it here, which is what the test asserts by naming each one.
 */

/** Query parameter names whose values are credentials. Compared case-insensitively. */
export const SECRET_QUERY_PARAMS = [
  "access_token", // Matrix appservice transactions — the one found in journald
  "token", // authMiddleware's bearer fallback reads this
  "code", // agentpod#406's one-time authorization code
  "code_verifier", // the PKCE verifier, if a client ever misplaces it into a URL
  "client_secret",
  "api_key",
  "apikey",
  "password",
  "secret",
] as const;

const PATTERN = new RegExp(
  `([?&](?:${SECRET_QUERY_PARAMS.join("|")})=)([^&\\s]+)`,
  "gi",
);

/**
 * Replace the value of any credential-bearing query parameter with `***`.
 *
 * Operates on the whole log line rather than on a parsed URL, because that is what Hono hands
 * a print function — and a line that cannot be parsed as a URL must still be redacted rather
 * than passed through.
 */
export function redactUrlSecrets(line: string): string {
  return line.replace(PATTERN, "$1***");
}
