/**
 * Signing in through the organization plane (issuer contract §3.1): OAuth 2.1 authorization code
 * + PKCE S256, as the first-party public client `agentpod-console`, with `resource` = the hub's
 * audience on every token request.
 *
 * Tokens live in this module's memory only — never in localStorage or sessionStorage. The contract:
 * "A product that cannot hold one securely re-runs authorize; the plane's session makes that
 * silent." So a new tab, a reload or a discarded mobile tab holds no token, and the layout's guard
 * goes straight back to authorize (`autoSignIn`, `prompt=none`) instead of showing /login. /login
 * is shown after an explicit sign-out in this browser (a non-secret marker in localStorage) and
 * when a sign-in fails. Stored besides: the pending PKCE verifier and state (sessionStorage, for
 * one redirect) and the times of recent automatic attempts (sessionStorage, the loop breaker).
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
/** "The person signed out in this browser": set by `signOut`, cleared by a completed sign-in. */
const SIGNED_OUT = "agentpod.planeSignedOut";
/** Times of this tab's recent automatic authorize attempts, to stop a cross-page-load loop. */
const AUTO_ATTEMPTS = "agentpod.autoSignIn";
const AUTO_WINDOW_MS = 60_000;
const AUTO_MAX_IN_WINDOW = 3;
/** Plane answers to `prompt=none` that mean "ask the person", not "refused". */
const NEEDS_INTERACTION = new Set(["login_required", "interaction_required", "consent_required", "account_selection_required"]);

let tokens: { access: string; expiresAt: number; refresh: string | null } | null = null;
/**
 * The refresh in flight, shared. Refresh tokens rotate, so two concurrent refreshes would spend the
 * same token twice — the second is refused, and a plane that detects reuse revokes the family.
 */
let refreshing: Promise<string | null> | null = null;

/** Bumped by every sign-out, so a token request that started before one cannot write tokens after it. */
let generation = 0;

/** Transient refresh failures in a row, and when the next background retry may run. */
let refreshFailures = 0;
let retryAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * This page load's automatic sign-in: not tried, under way (the page is leaving), or failed /
 * suppressed (a callback that failed, a hub that refused the token) — at most one per page load.
 */
let autoState: "idle" | "pending" | "done" = "idle";

/** The plane refused the grant (HTTP 400/401 from the token endpoint): the session is over. */
class RefusedError extends Error {}

const store = (s?: Storage) => s ?? sessionStorage;
const local = (s?: Storage) => s ?? localStorage;
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

export interface BeginOptions {
  returnTo: string;
  origin?: string;
  storage?: Storage;
  navigate?: (url: string) => void;
  /** `"none"`: ask the plane to answer without showing anything (an automatic sign-in). */
  prompt?: "none";
}

export function beginSignIn(plane: PlaneDiscovery, opts: BeginOptions): Promise<void> {
  if (!planeOrigin(plane.url)) return Promise.reject(new Error("The account service URL must be https."));
  signingIn ??= startSignIn(plane, opts).catch((err) => {
    signingIn = null; // nothing navigated: let a retry start over
    throw err;
  });
  return signingIn;
}

async function startSignIn(plane: PlaneDiscovery, opts: BeginOptions): Promise<void> {
  const origin = opts.origin ?? window.location.origin;
  const verifier = randomUrlSafe(48);
  const state = randomUrlSafe(24);
  const silent = opts.prompt === "none";
  store(opts.storage).setItem(PENDING, JSON.stringify({ verifier, state, returnTo: opts.returnTo, silent }));
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
  if (silent) q.set("prompt", "none");
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
  // 400/401 is the token endpoint's OAuth refusal (invalid_grant, invalid_client, ...). Anything
  // else that is not ok (5xx, 429, a proxy's page) says nothing about the grant.
  if (res.status === 400 || res.status === 401) {
    throw new RefusedError(`The account service refused the sign-in (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(`The account service is unavailable (HTTP ${res.status}).`);
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
): Promise<{ returnTo: string; interactive?: true }> {
  const s = store(opts.storage);
  let pending: { verifier: string; state: string; returnTo: string; silent?: boolean } | null = null;
  try {
    pending = JSON.parse(s.getItem(PENDING) ?? "null");
  } catch {
    pending = null;
  }
  s.removeItem(PENDING); // one use: a replayed callback finds nothing pending
  // Any failure below ends this page load's automatic sign-in, so the layout shows /login with the
  // error rather than going straight back into another authorize that fails the same way.
  const fail = (message: string): never => {
    suppressAutoSignIn();
    throw new Error(message);
  };
  const stateOk = !!pending && !!params.get("state") && params.get("state") === pending.state;
  const error = params.get("error");
  // A silent authorize the plane could not answer silently (no plane session, a workspace to
  // choose, consent to give): ask again, interactively. Only for OUR silent request — an
  // interactive one never comes back here as "silent", so this cannot loop.
  if (error && pending?.silent && stateOk && NEEDS_INTERACTION.has(error)) {
    return { returnTo: pending.returnTo || "/", interactive: true };
  }
  if (error) {
    const description = params.get("error_description");
    return fail(description ? `${description} (${error})` : error);
  }
  if (!pending || !stateOk) return fail("Sign-in state did not match; start again.");
  try {
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
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Sign-in failed.");
  }
  try {
    local().removeItem(SIGNED_OUT); // signed in again: automatic sign-in is back on
  } catch {
    // storage unavailable
  }
  return { returnTo: pending.returnTo || "/" };
}

interface TokenOptions {
  minValiditySec?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * The access token for the hub, refreshed first when it has under `minValiditySec` (default 30)
 * left. `null` when signed out, when the refresh is refused (which ends the session), or when the
 * token has expired and the plane cannot be reached right now.
 *
 * Only a refusal ends the session. A network error or a 5xx (a laptop waking, a phone changing
 * networks) keeps the tokens: the still-valid access token is the answer, and the refresh is
 * retried in the background with backoff (1 s doubling to 60 s), or at once when the token has
 * run out, or when the tab becomes visible or comes back online (`watchSession`).
 */
export async function planeAccessToken(plane: PlaneDiscovery, opts: TokenOptions = {}): Promise<string | null> {
  const now = opts.now ?? Date.now;
  if (!tokens) return null;
  const left = tokens.expiresAt - now();
  if (left > (opts.minValiditySec ?? 30) * 1000) return tokens.access;
  if (!tokens.refresh) return null;
  // Backing off after a transient failure: a token that still works is answer enough. One that has
  // run out is refreshed now regardless — the caller has nothing else to send.
  if (!refreshing && left > 0 && now() < retryAt) return tokens.access;
  return refreshNow(plane, opts);
}

function refreshNow(plane: PlaneDiscovery, opts: TokenOptions): Promise<string | null> {
  const now = opts.now ?? Date.now;
  if (!tokens?.refresh) return Promise.resolve(null);
  if (!refreshing) {
    const refreshToken = tokens.refresh;
    const gen = generation;
    let p: Promise<string | null> | undefined = undefined;
    p = (async () => {
      try {
        await tokenRequest(plane, { grant_type: "refresh_token", refresh_token: refreshToken }, opts.fetchFn ?? fetch, now);
        if (gen !== generation) return null;
        resetBackoff();
        return tokens?.access ?? null;
      } catch (err) {
        if (gen !== generation) return null;
        if (err instanceof RefusedError) {
          // The grant is dead (expired, revoked, reused). Never retried: the session is over, and
          // the guard re-authorizes — silently while the plane's session is alive.
          tokens = null;
          resetBackoff();
          return null;
        }
        refreshFailures++;
        const delay = Math.min(1_000 * 2 ** (refreshFailures - 1), 60_000);
        retryAt = now() + delay;
        scheduleRetry(plane, opts, delay);
        return tokens && tokens.expiresAt > now() ? tokens.access : null;
      } finally {
        if (refreshing === p) refreshing = null;
      }
    })();
    refreshing = p;
  }
  return refreshing;
}

function scheduleRetry(plane: PlaneDiscovery, opts: TokenOptions, delay: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  const gen = generation;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (gen === generation && tokens?.refresh) void refreshNow(plane, opts);
  }, delay);
}

function resetBackoff(): void {
  refreshFailures = 0;
  retryAt = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Whether this tab holds tokens (possibly expired, awaiting a refresh the network refused). */
export function hasTokens(): boolean {
  return tokens !== null;
}

/**
 * The hub answered 401. If it refused the token this tab holds, forget the tokens — not a
 * sign-out: no marker, and the guard re-authorizes. A request that carried no token (sent while a
 * refresh was failing) or an older one says nothing about the tokens held now, so they are kept.
 */
export function discardToken(sent: string | null | undefined): void {
  if (sent && tokens?.access === sent) signOutLocal();
}

/**
 * The layout's guard, for a visitor on a protected page with no token: go to the plane's
 * authorize with `prompt=none` — silent while the plane's session is alive; the plane answers
 * `login_required` otherwise, and the callback asks again interactively — and return `true`.
 * `false` sends the caller to /login: legacy mode, an explicit sign-out in this browser, an
 * attempt already failed or suppressed this page load, or a loop (three automatic attempts inside
 * a minute in this tab). While an attempt is under way the answer stays `true`, so a guard that
 * re-runs does not flash /login. `onError` hears an attempt that could not even start.
 */
export function autoSignIn(
  plane: PlaneDiscovery | null,
  returnTo: string,
  opts: { origin?: string; storage?: Storage; navigate?: (url: string) => void; now?: () => number; onError?: (err: unknown) => void } = {},
): boolean {
  if (!plane) return false;
  if (autoState === "pending") return true;
  if (autoState === "done" || userSignedOut()) return false;
  const t = (opts.now ?? Date.now)();
  let recent: number[] = [];
  try {
    const seen = JSON.parse(store(opts.storage).getItem(AUTO_ATTEMPTS) ?? "[]") as unknown;
    if (Array.isArray(seen)) recent = seen.filter((x): x is number => typeof x === "number" && t - x < AUTO_WINDOW_MS);
  } catch {
    recent = [];
  }
  if (recent.length >= AUTO_MAX_IN_WINDOW) {
    autoState = "done";
    return false;
  }
  try {
    store(opts.storage).setItem(AUTO_ATTEMPTS, JSON.stringify([...recent, t]));
  } catch {
    // storage unavailable: the per-page-load limit still holds
  }
  autoState = "pending";
  beginSignIn(plane, { origin: opts.origin, storage: opts.storage, navigate: opts.navigate, returnTo, prompt: "none" }).catch((err) => {
    autoState = "done";
    opts.onError?.(err);
  });
  return true;
}

/** No automatic sign-in for the rest of this page load (a failed callback, a refused token). */
export function suppressAutoSignIn(): void {
  autoState = "done";
}

/** What a new page load starts with. Tests use it to stand for one. */
export function resetPageLoadState(): void {
  autoState = "idle";
  signingIn = null;
}

/**
 * Keep the session alive across sleep and network changes, and follow another tab's sign-out.
 * Each tab holds its own tokens from its own grant, so tabs never share or spend each other's
 * refresh tokens; the one thing they share is the signed-out marker. Returns the unsubscribe.
 */
export function watchSession(
  getPlane: () => PlaneDiscovery | null,
  opts: { target?: Window; fetchFn?: typeof fetch; now?: () => number; onSignedOut?: () => void } = {},
): () => void {
  const target = opts.target ?? window;
  const wake = () => {
    const p = getPlane();
    if (!p || !tokens || target.document.visibilityState === "hidden") return;
    retryAt = 0; // the network may well be back: skip the rest of the backoff
    void planeAccessToken(p, { minValiditySec: 60, fetchFn: opts.fetchFn, now: opts.now });
  };
  const storage = (e: StorageEvent) => {
    if (e.key !== SIGNED_OUT || e.newValue !== "1") return;
    signOutLocal();
    autoState = "done";
    opts.onSignedOut?.();
  };
  target.addEventListener("online", wake);
  target.document.addEventListener("visibilitychange", wake);
  target.addEventListener("storage", storage);
  return () => {
    target.removeEventListener("online", wake);
    target.document.removeEventListener("visibilitychange", wake);
    target.removeEventListener("storage", storage);
  };
}

/**
 * Forget the tokens, here only. Not a sign-out: automatic sign-in stays on (the 401 path).
 * `signOut` is the person's sign-out, and also revokes at the plane.
 *
 * It does NOT touch a sign-in that is under way. This runs on every 401 (`handleUnauthorized`),
 * and on a fresh load the panes fetch before any token exists — so it fired while the guard's
 * redirect to the plane was in flight, deleted the pending state, and the callback refused the
 * plane's answer ("Sign-in state did not match", production 2026-10-07). The pending sign-in is
 * consumed by `completeSignIn` and abandoned only by an explicit `signOut`.
 */
export function signOutLocal(): void {
  generation++;
  tokens = null;
  refreshing = null;
  resetBackoff();
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

/** Whether the person signed out in this browser (and has not signed in since). */
export function userSignedOut(storage?: Storage): boolean {
  try {
    return local(storage).getItem(SIGNED_OUT) === "1";
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
  try {
    local().setItem(SIGNED_OUT, "1"); // so the guard shows /login instead of signing straight back in
  } catch {
    // storage unavailable: this page load still stops (below); a later one may sign in silently
  }
  autoState = "done";
  signOutLocal();
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
