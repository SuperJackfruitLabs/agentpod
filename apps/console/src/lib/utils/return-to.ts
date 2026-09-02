/**
 * Where to send someone after they sign in, when something else asked for them back.
 *
 * `GET /api/auth/authorize` on the hub — the door a plane on another registrable domain walks
 * through to get a token (`apps/hub/src/routes/auth-authorize.ts`) — 302s to the hub's configured
 * sign-in URL when there is no session, carrying `?redirect=<the authorize URL to resume>`. That
 * sign-in URL is this console's `/login`. Until this existed, `/login` called `goto("/")` on
 * success unconditionally, so the operator signed in and landed on the console home: the flow
 * dead-ended for exactly the person it was built for, someone who was not already signed in.
 *
 * **The whole difficulty is that a login page which forwards anywhere is a phishing gadget.** It
 * authenticates you and then hands you to a destination chosen by whoever wrote the link, on a
 * page you arrived at expecting to be asked for a password. So the answer is an allowlist of two
 * origins and nothing else: this console's own, and the hub this console is connected to. Anything
 * else — another origin, a protocol-relative `//host` that resolves to one, a `javascript:` URL,
 * an unparseable string, no parameter at all — is `/`.
 */

/** The parameter the hub's authorize endpoint sets. Named there; do not rename one without the other. */
export const RETURN_PARAM = "redirect";

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The destination to use after a successful sign-in.
 *
 * Returns a **path** (always starting with `/`) when the destination is this console's own, and an
 * **absolute URL** when it is the hub's. That distinction is the caller's instruction: SvelteKit's
 * `goto` refuses a URL on another origin, so the hub case has to be a real browser navigation.
 * `"/"` is both the fallback and an ordinary answer — most sign-ins have no return path at all.
 *
 * @param raw       the `redirect` parameter as it arrived, untrusted
 * @param hubUrl    the hub this console is connected to (`connection.apiUrl`), or null
 * @param appOrigin this page's own origin
 */
export function resolveReturnTo(
  raw: string | null | undefined,
  hubUrl: string | null | undefined,
  appOrigin: string
): string {
  if (!raw) return "/";

  let target: URL;
  try {
    // Resolved against our own origin so a bare path works — and so that `//evil.example/x`
    // resolves to a real origin that the checks below can then refuse, rather than being compared
    // as a string that looks like a path.
    target = new URL(raw, appOrigin);
  } catch {
    return "/";
  }

  // `javascript:`, `data:` and friends parse fine and have no useful origin. Refused by scheme
  // rather than by origin, because "origin is not ours" is the right answer for the wrong reason.
  if (target.protocol !== "https:" && target.protocol !== "http:") return "/";

  if (target.origin === appOrigin) return `${target.pathname}${target.search}${target.hash}`;

  // The hub the operator is actually connected to, not a compiled-in default: a console pointed at
  // someone's own hub must resume that hub's authorize, and must not resume any other.
  const hubOrigin = originOf(hubUrl);
  if (hubOrigin && target.origin === hubOrigin) return target.href;

  return "/";
}

/**
 * Leave the app entirely.
 *
 * Separate from `goto` because `goto` is for internal navigation and throws on a cross-origin URL,
 * and separate from an inline `window.location.assign` because jsdom's `Location` is unforgeable —
 * a test cannot spy on it, so the one call that leaves this origin has to be somewhere a test can
 * stand in for. That is the only reason this is a function.
 */
export function hardNavigate(url: string): void {
  window.location.assign(url);
}
