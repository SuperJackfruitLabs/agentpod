/**
 * The person's own Superlibrary sign-in: a second grant, separate from the hub's (org-plane.ts).
 *
 * Why separate: the plane binds a refresh token to the resources it was authorized for. The hub's
 * grant was authorized for the hub only, so it cannot buy a Superlibrary token, and authorizing
 * both on the hub's grant would let a Superlibrary refresh narrow it and sign the person out of the
 * hub. So Superlibrary gets its own authorization code + PKCE grant (`resource` = Superlibrary),
 * with its own refresh token, its own single-flight and its own pending state. The two never spend
 * each other's tokens, and a refusal of one never ends the other.
 *
 * How it stays silent: the authorize runs in a small window opened by the person's click (a hidden
 * frame cannot work: the plane refuses to be framed, and a cross-site frame has no plane cookie on
 * Safari). It asks with `prompt=none`, so the plane's own session answers at once and the window
 * closes itself. When the plane needs the person (`login_required`, `interaction_required`,
 * `consent_required`), the same window goes on to the plane's interactive page, and the link
 * resumes when it answers. The window lands on the console's registered `/auth/callback`, which
 * relays the answer here over a same-origin BroadcastChannel; this page trades the code. The
 * verifier and state never leave this page's memory.
 *
 * Tokens live in memory only, like the hub's. Only an explicit sign-out (or another tab's) ends this
 * grant besides the plane refusing it; a 401 from the hub does not, and a 401 from Superlibrary only
 * drops the access token so the next call refreshes.
 */
import { CLIENT_ID, NEEDS_INTERACTION, SCOPE, planeOrigin, revokeAtPlane, type PlaneDiscovery } from "./org-plane";
import { challengeFor, randomUrlSafe } from "./pkce";

/** Superlibrary's audience. The `agentpod-console` client may ask the plane for it (issuer contract 3.1). */
export const SUPERLIBRARY_AUDIENCE = "https://app.superlibrary.dev";

/** Every Superlibrary grant's `state` starts with this, so `/auth/callback` can tell it from the hub's. */
const STATE_PREFIX = "sl.";
const CHANNEL = "agentpod.superlibrary-grant";
const WINDOW_NAME = "agentpod-superlibrary-sign-in";
const WINDOW_FEATURES = "popup,width=480,height=640";
/** How long the person has to finish an interactive sign-in in the window. */
const GRANT_TIMEOUT_MS = 5 * 60_000;
/** A token request is tried this many times when the network or the plane is down (not refused). */
const ATTEMPTS = 3;

const BLOCKED = "Your browser blocked the Superlibrary sign-in window. Allow pop-ups for this site and press Link this file again.";
const CLOSED = "The Superlibrary sign-in window was closed before it finished. Press Link this file again.";
const ENDED = "Superlibrary asked you to sign in again. Press Link this file again.";
const UNAVAILABLE = "The account service is unavailable, so Superlibrary could not be signed in to. Try again in a moment.";

/** The window opened for the authorize (a real `Window` in the browser). */
export interface PopupLike {
  readonly closed: boolean;
  location: { replace(url: string): void };
  close(): void;
  focus(): void;
}

/** A BroadcastChannel, as far as this module uses one. */
export interface ChannelLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

export interface GrantOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  origin?: string;
  minValiditySec?: number;
  open?: (url: string, name: string, features: string) => PopupLike | null;
  channel?: () => ChannelLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

type Message =
  | { kind: "callback"; search: string }
  | { kind: "navigate"; state: string; url: string }
  | { kind: "done"; state: string };

let tokens: { access: string; expiresAt: number; refresh: string | null } | null = null;
/** The refresh in flight, shared: refresh tokens rotate, so two at once would spend one twice. */
let refreshing: Promise<string> | null = null;
/** The authorize in flight (the window), shared: a second click focuses it instead of opening another. */
let signingIn: { promise: Promise<string>; cancel: (why: Error) => void; win: PopupLike } | null = null;
/** Bumped by every sign-out, so a grant that started before one cannot store tokens after it. */
let generation = 0;

/** The plane refused the grant (HTTP 400/401 from its token endpoint). */
class RefusedError extends Error {}

const base = (url: string) => url.replace(/\/+$/, "");
const redirectUri = (origin: string) => `${origin}/auth/callback`;
const defaultChannel = (): ChannelLike => new BroadcastChannel(CHANNEL) as unknown as ChannelLike;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Whether this tab holds a Superlibrary grant (its access token may need a refresh). */
export function hasSuperlibraryGrant(): boolean {
  return tokens !== null;
}

/**
 * The person's Superlibrary access token. Call it straight from the click, before any `await`: when
 * there is no grant yet it opens the sign-in window, and a browser blocks a window opened after the
 * click's task has ended. Throws a sentence when no token can be had.
 */
export function superlibraryAccessToken(plane: PlaneDiscovery, opts: GrantOptions = {}): Promise<string> {
  const now = opts.now ?? Date.now;
  if (tokens && tokens.expiresAt - now() > (opts.minValiditySec ?? 30) * 1000) return Promise.resolve(tokens.access);
  if (tokens?.refresh) return refresh(plane, opts);
  return signIn(plane, opts);
}

/** Superlibrary answered 401 to a request that carried `sent`: drop that access token, keep the grant. */
export function discardSuperlibraryAccess(sent: string | null | undefined): void {
  if (sent && tokens?.access === sent) tokens = { ...tokens, expiresAt: 0 };
}

/** Forget the grant here only (another tab's sign-out, a hub switch). The window, if open, is abandoned. */
export function forgetSuperlibraryGrant(): void {
  generation++;
  tokens = null;
  refreshing = null;
  if (signingIn) {
    const s = signingIn;
    signingIn = null;
    s.cancel(new Error("Signed out."));
  }
}

/** The person's sign-out: forget the grant, then revoke its refresh token at the plane (best effort). */
export async function signOutOfSuperlibrary(
  plane: PlaneDiscovery | null,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const refreshToken = tokens?.refresh ?? null;
  forgetSuperlibraryGrant();
  if (plane && refreshToken) await revokeAtPlane(plane, refreshToken, opts);
}

function refresh(plane: PlaneDiscovery, opts: GrantOptions): Promise<string> {
  const now = opts.now ?? Date.now;
  if (refreshing) return refreshing;
  const gen = generation;
  let p: Promise<string> | undefined = undefined;
  p = (async () => {
    try {
      const refreshToken = tokens?.refresh;
      if (!refreshToken) throw new Error(ENDED);
      let grant: Grant;
      try {
        grant = await tokenRequest(plane, { grant_type: "refresh_token", refresh_token: refreshToken }, opts);
      } catch (err) {
        if (gen !== generation) throw new Error("Signed out.");
        if (err instanceof RefusedError) {
          // This grant is over (expired, revoked, reused). The hub's is not touched: the next click
          // runs a new authorize, silent while the plane's session is alive.
          tokens = null;
          throw new Error(ENDED);
        }
        // Down, not refused: keep the grant. A token that still works is the answer.
        if (tokens && tokens.expiresAt > now()) return tokens.access;
        throw new Error(UNAVAILABLE);
      }
      if (gen !== generation) throw new Error("Signed out.");
      tokens = { access: grant.access, expiresAt: grant.expiresAt, refresh: grant.refresh ?? refreshToken };
      return grant.access;
    } finally {
      if (refreshing === p) refreshing = null;
    }
  })();
  refreshing = p;
  return p;
}

function signIn(plane: PlaneDiscovery, opts: GrantOptions): Promise<string> {
  if (signingIn && !signingIn.win.closed) {
    signingIn.win.focus();
    return signingIn.promise;
  }
  if (!planeOrigin(plane.url)) return Promise.reject(new Error("The account service URL must be https."));
  // Synchronously, inside the click: an empty window now, sent to the plane once PKCE is ready.
  const open = opts.open ?? ((url, name, features) => window.open(url, name, features) as PopupLike | null);
  const win = open("about:blank", WINDOW_NAME, WINDOW_FEATURES);
  if (!win) return Promise.reject(new Error(BLOCKED));

  const origin = opts.origin ?? window.location.origin;
  const gen = generation;
  const channel = (opts.channel ?? defaultChannel)();
  let pending: { state: string; verifier: string; silent: boolean } | null = null;
  let settle: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let poll: ReturnType<typeof setInterval> | null = null;

  const authorizeUrl = async (silent: boolean): Promise<string> => {
    const verifier = randomUrlSafe(48);
    const state = STATE_PREFIX + randomUrlSafe(24);
    pending = { state, verifier, silent };
    const q = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(origin),
      scope: SCOPE,
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
      resource: SUPERLIBRARY_AUDIENCE,
    });
    if (silent) q.set("prompt", "none");
    return `${base(plane.url)}/api/auth/oauth2/authorize?${q}`;
  };

  const finish = () => {
    channel.onmessage = null;
    channel.close();
    for (const t of timers) clearTimeout(t);
    if (poll) clearInterval(poll);
    if (signingIn?.promise === promise) signingIn = null;
  };

  const promise = new Promise<string>((resolve, reject) => {
    settle = {
      resolve: (t) => {
        finish();
        resolve(t);
      },
      reject: (e) => {
        finish();
        reject(e);
      },
    };
  });
  const fail = (e: Error) => settle?.reject(e);

  channel.onmessage = (e) => {
    const m = e.data as Message | null;
    if (!m || m.kind !== "callback" || typeof m.search !== "string") return;
    const params = new URLSearchParams(m.search);
    const state = params.get("state");
    const p = pending;
    if (!p || !state || state !== p.state) return; // another grant's answer, or a forgery
    pending = null; // one use
    const error = params.get("error");
    if (error && p.silent && NEEDS_INTERACTION.has(error)) {
      // The plane needs the person: the same window goes on to the interactive page.
      void authorizeUrl(false).then((url) => channel.postMessage({ kind: "navigate", state, url } satisfies Message), fail);
      return;
    }
    channel.postMessage({ kind: "done", state } satisfies Message);
    if (error) {
      const description = params.get("error_description");
      fail(new Error(`Superlibrary sign-in did not complete: ${description ? `${description} (${error})` : error}.`));
      return;
    }
    tokenRequest(plane, { grant_type: "authorization_code", code: params.get("code") ?? "", redirect_uri: redirectUri(origin), code_verifier: p.verifier }, opts).then(
      (grant) => {
        if (gen !== generation) return fail(new Error("Signed out."));
        tokens = grant;
        settle?.resolve(grant.access);
      },
      (err: unknown) => fail(err instanceof RefusedError ? new Error("The account service would not give you a Superlibrary sign-in. Press Link this file again.") : new Error(UNAVAILABLE)),
    );
  };

  signingIn = { promise, cancel: fail, win };
  authorizeUrl(true).then(
    (url) => {
      if (gen === generation) win.location.replace(url);
    },
    (err: unknown) => {
      win.close();
      fail(err instanceof Error ? err : new Error("Superlibrary sign-in could not start."));
    },
  );
  // The person closed the window. The plane sends no Cross-Origin-Opener-Policy, so `closed` is
  // truthful while the window is on the plane's pages; a grace period lets a closing window's last
  // message (the callback relays, then closes) arrive first.
  poll = setInterval(() => {
    if (!win.closed) return;
    if (poll) clearInterval(poll);
    poll = null;
    timers.push(setTimeout(() => fail(new Error(CLOSED)), 1_500));
  }, 500);
  timers.push(setTimeout(() => fail(new Error(CLOSED)), opts.timeoutMs ?? GRANT_TIMEOUT_MS));
  return promise;
}

interface Grant {
  access: string;
  expiresAt: number;
  refresh: string | null;
}

/**
 * One token request for Superlibrary's audience, retried when the network or the plane is down
 * (never when refused: 400/401 is the plane's answer about the grant). An authorization code is
 * spent by its first arrival, so a retried code exchange may be refused; that is reported as such.
 */
async function tokenRequest(plane: PlaneDiscovery, body: Record<string, string>, opts: GrantOptions): Promise<Grant> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  let last: unknown = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(1_000 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetchFn(`${base(plane.url)}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...body, client_id: CLIENT_ID, resource: SUPERLIBRARY_AUDIENCE }).toString(),
      });
    } catch (err) {
      last = err;
      continue;
    }
    if (res.status === 400 || res.status === 401) throw new RefusedError(`The account service refused (HTTP ${res.status}).`);
    if (!res.ok) {
      last = new Error(`HTTP ${res.status}`);
      continue;
    }
    const j = (await res.json()) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
    if (typeof j.access_token !== "string" || !j.access_token) throw new Error("The account service answered without an access token.");
    const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 300;
    return { access: j.access_token, expiresAt: now() + expiresIn * 1000, refresh: typeof j.refresh_token === "string" ? j.refresh_token : null };
  }
  throw last instanceof Error ? last : new Error(UNAVAILABLE);
}

/**
 * Run by `/auth/callback` first. When the answer is a Superlibrary grant's (its state says so), it
 * relays it to the page that opened this window and returns true; that page answers with the next
 * step (go on to the interactive authorize) or that it is done, and this window closes. Otherwise
 * it returns false and touches nothing: the callback is the hub's sign-in.
 */
export function relaySuperlibraryCallback(
  search: string,
  opts: { channel?: ChannelLike | (() => ChannelLike); close?: () => void; navigate?: (url: string) => void; waitMs?: number } = {},
): boolean {
  const params = new URLSearchParams(search);
  const state = params.get("state");
  if (!state?.startsWith(STATE_PREFIX)) return false;
  const channel = typeof opts.channel === "function" ? opts.channel() : (opts.channel ?? defaultChannel());
  const close = opts.close ?? (() => window.close());
  const navigate = opts.navigate ?? ((url: string) => window.location.replace(url));
  // No answer (the opening page was closed or reloaded): close anyway; nothing here is usable.
  const giveUp = setTimeout(() => {
    channel.onmessage = null;
    channel.close();
    close();
  }, opts.waitMs ?? 15_000);
  channel.onmessage = (e) => {
    const m = e.data as Message | null;
    if (!m || m.kind === "callback" || m.state !== state) return;
    clearTimeout(giveUp);
    channel.onmessage = null;
    channel.close();
    if (m.kind === "navigate" && typeof m.url === "string" && m.url.startsWith("http")) navigate(m.url);
    else close();
  };
  channel.postMessage({ kind: "callback", search } satisfies Message);
  return true;
}
