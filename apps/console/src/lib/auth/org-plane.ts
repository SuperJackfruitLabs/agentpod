/**
 * Signing in through the organization plane (issuer contract §3.1): OAuth 2.1 authorization code
 * + PKCE S256, as the first-party public client `agentpod-console`, with `resource` = the hub's
 * audience on every token request.
 *
 * Tokens live in this module's memory only — never in localStorage or sessionStorage. The contract:
 * "A product that cannot hold one securely re-runs authorize; the plane's session makes that
 * silent." So a reload loses them, and the layout re-runs authorize when `wasSignedIn()` says this
 * tab had signed in. The only things written to sessionStorage are the pending PKCE verifier and
 * state (for the length of one redirect) and a non-secret "signed in" flag.
 *
 * Which plane, if any, comes from the hub: `GET /public/org-plane` answers `{ issuer: null }` on a
 * hub that still issues its own sessions (legacy), and an older hub 404s it. Both mean legacy.
 */
import { challengeFor, randomUrlSafe } from "./pkce";

export interface PlaneDiscovery {
  issuer: string;
  url: string;
  audience: string;
}

export const CLIENT_ID = "agentpod-console";
export const SCOPE = "openid profile email offline_access";

const PENDING = "agentpod.pkce";
const SIGNED_IN = "agentpod.planeSignedIn";

let tokens: { access: string; expiresAt: number; refresh: string | null } | null = null;
/**
 * The refresh in flight, shared. Refresh tokens rotate, so two concurrent refreshes would spend the
 * same token twice — the second is refused, and a plane that detects reuse revokes the family.
 */
let refreshing: Promise<string | null> | null = null;

/** Bumped by every sign-out, so a token request that started before one cannot write tokens after it. */
let generation = 0;

const store = (s?: Storage) => s ?? sessionStorage;
const redirectUri = (origin: string) => `${origin}/auth/callback`;
const base = (url: string) => url.replace(/\/+$/, "");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The plane URL as a URL, or null unless it is https — plain http only for a loopback host, the
 * hub's own rule for ORG_PLANE_URL. The browser is sent there to sign in (security review finding 6).
 */
export function planeOrigin(url: string): URL | null {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) return u;
  } catch {
    // not a URL
  }
  return null;
}

/** Ask the hub which plane it trusts. `null` is legacy: no plane, an older hub, or no answer at all. */
export async function discoverPlane(hub: string, fetchFn: typeof fetch = fetch): Promise<PlaneDiscovery | null> {
  try {
    const res = await fetchFn(`${base(hub)}/public/org-plane`);
    if (!res.ok) return null;
    const body = (await res.json()) as { issuer?: unknown; url?: unknown; audience?: unknown } | null;
    if (!body || typeof body.issuer !== "string" || typeof body.url !== "string" || typeof body.audience !== "string") {
      return null;
    }
    if (!body.issuer || !body.url || !body.audience) return null;
    if (!planeOrigin(body.url)) return null; // a hub naming a non-https plane is not followed
    return { issuer: body.issuer, url: base(body.url), audience: body.audience };
  } catch {
    return null;
  }
}

/** Leave for the plane's authorize page. `returnTo` is where `completeSignIn` sends the user back. */
/**
 * The sign-in redirect this page has started, if any. Single-flight: the layout's guard is a
 * $effect and can fire again while the first call is still awaiting its PKCE challenge. A second
 * call that saved a fresh state would overwrite the first's while the browser follows the FIRST
 * redirect, and the callback would refuse it ("Sign-in state did not match"). Seen in production
 * on 2026-10-07. The page is about to leave, so this is never reset except by signOutLocal.
 */
let signingIn: Promise<void> | null = null;

export function beginSignIn(
  plane: PlaneDiscovery,
  opts: { returnTo: string; origin?: string; storage?: Storage; navigate?: (url: string) => void },
): Promise<void> {
  if (!planeOrigin(plane.url)) return Promise.reject(new Error("The account service URL must be https."));
  signingIn ??= startSignIn(plane, opts).catch((err) => {
    signingIn = null; // nothing navigated: let a retry start over
    throw err;
  });
  return signingIn;
}

async function startSignIn(
  plane: PlaneDiscovery,
  opts: { returnTo: string; origin?: string; storage?: Storage; navigate?: (url: string) => void },
): Promise<void> {
  const origin = opts.origin ?? window.location.origin;
  const verifier = randomUrlSafe(48);
  const state = randomUrlSafe(24);
  store(opts.storage).setItem(PENDING, JSON.stringify({ verifier, state, returnTo: opts.returnTo }));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(origin),
    scope: SCOPE,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    resource: plane.audience,
  });
  (opts.navigate ?? ((u: string) => window.location.assign(u)))(`${base(plane.url)}/api/auth/oauth2/authorize?${q}`);
}

async function tokenRequest(
  plane: PlaneDiscovery,
  body: Record<string, string>,
  fetchFn: typeof fetch,
  now: () => number,
): Promise<void> {
  const gen = generation;
  const res = await fetchFn(`${base(plane.url)}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // The contract: the token request MUST carry resource=<audience>, on refresh as well.
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID, resource: plane.audience }).toString(),
  });
  if (!res.ok) throw new Error(`The account service refused the sign-in (HTTP ${res.status}).`);
  const j = (await res.json()) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
  if (typeof j.access_token !== "string" || !j.access_token) {
    throw new Error("The account service answered without an access token.");
  }
  const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 300;
  if (gen !== generation) return; // signed out meanwhile: the answer belongs to nobody now
  tokens = {
    access: j.access_token,
    expiresAt: now() + expiresIn * 1000,
    // Refresh tokens rotate: the newest one replaces the old, which the plane has now spent.
    refresh: typeof j.refresh_token === "string" ? j.refresh_token : (tokens?.refresh ?? null),
  };
}

/** Finish the redirect at `/auth/callback`: check state, trade the code + verifier for tokens. */
export async function completeSignIn(
  params: URLSearchParams,
  plane: PlaneDiscovery,
  opts: { origin?: string; storage?: Storage; fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<{ returnTo: string }> {
  const s = store(opts.storage);
  let pending: { verifier: string; state: string; returnTo: string } | null = null;
  try {
    pending = JSON.parse(s.getItem(PENDING) ?? "null");
  } catch {
    pending = null;
  }
  s.removeItem(PENDING); // one use: a replayed callback finds nothing pending
  // A failed sign-in also drops the signed-in flag, so the layout sends the user to /login rather
  // than straight back into another authorize that fails the same way.
  s.removeItem(SIGNED_IN);
  const error = params.get("error");
  if (error) throw new Error(params.get("error_description") ?? error);
  if (!pending || !params.get("state") || params.get("state") !== pending.state) {
    throw new Error("Sign-in state did not match; start again.");
  }
  await tokenRequest(
    plane,
    {
      grant_type: "authorization_code",
      code: params.get("code") ?? "",
      redirect_uri: redirectUri(opts.origin ?? window.location.origin),
      code_verifier: pending.verifier,
    },
    opts.fetchFn ?? fetch,
    opts.now ?? Date.now,
  );
  s.setItem(SIGNED_IN, "1");
  return { returnTo: pending.returnTo || "/" };
}

/**
 * The access token for the hub, refreshed first when it has under `minValiditySec` (default 30)
 * left. `null` when signed out, or when the refresh is refused (which signs out).
 */
export async function planeAccessToken(
  plane: PlaneDiscovery,
  opts: { minValiditySec?: number; fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now;
  if (!tokens) return null;
  if (tokens.expiresAt - now() > (opts.minValiditySec ?? 30) * 1000) return tokens.access;
  if (!tokens.refresh) return null;
  if (!refreshing) {
    const refreshToken = tokens.refresh;
    const gen = generation;
    let p: Promise<string | null> | undefined = undefined;
    p = (async () => {
      try {
        await tokenRequest(plane, { grant_type: "refresh_token", refresh_token: refreshToken }, opts.fetchFn ?? fetch, now);
        return gen === generation ? (tokens?.access ?? null) : null;
      } catch {
        if (gen === generation) tokens = null;
        return null;
      } finally {
        if (refreshing === p) refreshing = null;
      }
    })();
    refreshing = p;
  }
  return refreshing;
}

/**
 * The layout guard's answer for a signed-out visitor on a protected page: when this tab had signed
 * in through the plane (so this is a reload, which forgot the memory-only tokens), go back to
 * authorize — silent while the plane's session is alive — and return `true`. Otherwise `false`,
 * and the caller sends the visitor to /login as before.
 */
export function reauthorizeIfSignedIn(
  plane: PlaneDiscovery | null,
  returnTo: string,
  opts: { origin?: string; storage?: Storage; navigate?: (url: string) => void } = {},
): boolean {
  if (!plane || !wasSignedIn(opts.storage)) return false;
  void beginSignIn(plane, { ...opts, returnTo });
  return true;
}

/**
 * Forget the tokens and the signed-in flag, here only. `signOut` also revokes at the plane.
 *
 * It does NOT touch a sign-in that is under way. This runs on every 401 (`handleUnauthorized`),
 * and on a fresh load the panes fetch before any token exists — so it fired while the guard's
 * redirect to the plane was in flight, deleted the pending state, and the callback refused the
 * plane's answer ("Sign-in state did not match", production 2026-10-07). The pending sign-in is
 * consumed by `completeSignIn` and abandoned only by an explicit `signOut`.
 */
export function signOutLocal(storage?: Storage): void {
  generation++;
  tokens = null;
  refreshing = null;
  try {
    store(storage).removeItem(SIGNED_IN);
  } catch {
    // storage unavailable: nothing to clear
  }
}

/** Drop a sign-in under way (its saved state and the in-flight redirect). Explicit sign-out only. */
export function abandonPendingSignIn(storage?: Storage): void {
  signingIn = null;
  try {
    store(storage).removeItem(PENDING);
  } catch {
    // storage unavailable: nothing to clear
  }
}

/** Whether this tab signed in through the plane — so a reload re-authorizes silently. */
export function wasSignedIn(storage?: Storage): boolean {
  try {
    return store(storage).getItem(SIGNED_IN) === "1";
  } catch {
    return false;
  }
}

/**
 * Log out: forget everything here first (so nothing below can leave a token behind), then revoke
 * the refresh token at the plane (RFC 7009) — at the `revocation_endpoint` its discovery
 * (`/.well-known/oauth-authorization-server`, RFC 8414) names, and only when that endpoint is on
 * the plane's own origin. Best effort and bounded: an unreachable plane still leaves this tab
 * signed out, and the token then dies by expiry (security review finding 7a). The plane's own
 * browser session is the plane's to end.
 */
export async function signOut(
  plane: PlaneDiscovery | null,
  opts: { storage?: Storage; fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const refresh = tokens?.refresh ?? null;
  signOutLocal(opts.storage);
  abandonPendingSignIn(opts.storage); // a sign-out the person chose ends any sign-in under way
  if (!plane || !refresh) return;
  const origin = planeOrigin(plane.url);
  if (!origin) return;
  const fetchFn = opts.fetchFn ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 5_000);
  try {
    const meta = await fetchFn(`${base(plane.url)}/.well-known/oauth-authorization-server`, { signal });
    if (!meta.ok) return;
    const { revocation_endpoint: endpoint } = (await meta.json()) as { revocation_endpoint?: unknown };
    if (typeof endpoint !== "string") return;
    const target = new URL(endpoint, origin);
    if (target.origin !== origin.origin) return; // never hand the token to another host
    await fetchFn(target.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh, token_type_hint: "refresh_token", client_id: CLIENT_ID }).toString(),
      signal,
    });
  } catch {
    // unreachable or refused: this tab is signed out regardless
  }
}
