/**
 * The console's second, separate grant: Superlibrary's audience, for "Link this file". Its own
 * authorize (prompt=none in a popup, interactive in the same popup when the plane needs the person),
 * its own refresh token, its own single-flight, its own pending state. The hub's grant never
 * spends it, and it never spends the hub's.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { abandonPendingSignIn, beginSignIn, completeSignIn, discardToken, hasTokens, planeAccessToken, resetPageLoadState, signOutLocal } from "./org-plane";
import {
  SUPERLIBRARY_AUDIENCE,
  discardSuperlibraryAccess,
  forgetSuperlibraryGrant,
  hasSuperlibraryGrant,
  relaySuperlibraryCallback,
  signOutOfSuperlibrary,
  superlibraryAccessToken,
  type ChannelLike,
  type GrantOptions,
  type PopupLike,
} from "./superlibrary-grant";

const PLANE = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.test" };
const ORIGIN = "https://console.test";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A same-origin BroadcastChannel stand-in: every instance hears every other instance's messages. */
function bus() {
  const members = new Set<ChannelLike>();
  return (): ChannelLike => {
    const ch: ChannelLike = {
      onmessage: null,
      postMessage(data: unknown) {
        for (const m of members) if (m !== ch) queueMicrotask(() => m.onmessage?.({ data }));
      },
      close() {
        members.delete(ch);
      },
    };
    members.add(ch);
    return ch;
  };
}

interface TokenCall {
  grant: string | null;
  resource: string | null;
  refresh: string | null;
  verifier: string | null;
  client: string | null;
}

/** The popup, the plane's token endpoint, and the popup landing back on /auth/callback. */
function harness(answers: Array<() => Response | Promise<Response>> = []) {
  const channel = bus();
  const went: string[] = [];
  const win: PopupLike & { closed: boolean } = {
    closed: false,
    location: { replace: (u: string) => void went.push(u) },
    close() {
      this.closed = true;
    },
    focus() {},
  };
  const open = vi.fn((_url: string, _name: string, _features: string) => win as PopupLike | null);
  const calls: TokenCall[] = [];
  let n = 0;
  const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
    const b = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ grant: b.get("grant_type"), resource: b.get("resource"), refresh: b.get("refresh_token"), verifier: b.get("code_verifier"), client: b.get("client_id") });
    const a = answers[n++];
    return a ? a() : json(200, { access_token: `sl-at${n}`, expires_in: 300, refresh_token: `sl-rt${n}` });
  });
  const opts: GrantOptions = { open, channel, fetchFn: fetchFn as never, origin: ORIGIN, now: () => 0, sleep: async () => {} };
  /** The plane sends the popup back to /auth/callback with these parameters. */
  const land = (params: Record<string, string>) =>
    relaySuperlibraryCallback(`?${new URLSearchParams(params)}`, {
      channel,
      close: () => win.close(),
      navigate: (u) => void went.push(u),
      waitMs: 1_000,
    });
  const lastUrl = () => new URL(went[went.length - 1]!);
  const navigated = (count: number) => vi.waitFor(() => expect(went.length).toBe(count));
  return { open, win, went, calls, fetchFn, opts, land, lastUrl, navigated };
}

/** A Superlibrary grant held: one silent popup round trip. */
async function granted(h = harness()) {
  const p = superlibraryAccessToken(PLANE, h.opts);
  await h.navigated(1);
  expect(h.land({ code: "c1", state: h.lastUrl().searchParams.get("state")! })).toBe(true);
  return { token: await p, h };
}

/** The hub's own grant held, through its own authorize + callback (org-plane). */
async function hubSignedIn() {
  let went = "";
  await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
  const state = new URL(went).searchParams.get("state")!;
  resetPageLoadState();
  await completeSignIn(new URLSearchParams({ code: "hc", state }), PLANE, {
    origin: ORIGIN,
    now: () => 0,
    fetchFn: (async () => json(200, { access_token: "hub-at1", expires_in: 300, refresh_token: "hub-rt1" })) as never,
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  signOutLocal();
  abandonPendingSignIn();
  resetPageLoadState();
  forgetSuperlibraryGrant();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("silent grant", () => {
  test("opens the popup in the same tick (the click), asks with prompt=none for Superlibrary's audience, and trades the code", async () => {
    const h = harness();
    const p = superlibraryAccessToken(PLANE, h.opts);
    // Synchronously: a popup opened after an await is no longer the person's gesture, and is blocked.
    expect(h.open).toHaveBeenCalledTimes(1);
    await h.navigated(1);
    const u = h.lastUrl();
    expect(u.origin + u.pathname).toBe("https://accounts.test/api/auth/oauth2/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "agentpod-console",
      redirect_uri: "https://console.test/auth/callback",
      code_challenge_method: "S256",
      resource: SUPERLIBRARY_AUDIENCE,
      prompt: "none",
    });
    expect(u.searchParams.get("scope")).toContain("offline_access");
    const state = u.searchParams.get("state")!;
    expect(state.startsWith("sl.")).toBe(true);

    expect(h.land({ code: "c1", state })).toBe(true);
    expect(await p).toBe("sl-at1");
    expect(h.calls).toEqual([{ grant: "authorization_code", resource: SUPERLIBRARY_AUDIENCE, refresh: null, verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,}$/), client: "agentpod-console" }]);
    await vi.waitFor(() => expect(h.win.closed).toBe(true));
    expect(hasSuperlibraryGrant()).toBe(true);

    // Held in memory: the next link opens nothing and asks nothing.
    expect(await superlibraryAccessToken(PLANE, h.opts)).toBe("sl-at1");
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(1);
  });

  test("two clicks while the popup is open share one grant: one popup, one authorize", async () => {
    const h = harness();
    const a = superlibraryAccessToken(PLANE, h.opts);
    const b = superlibraryAccessToken(PLANE, h.opts);
    expect(h.open).toHaveBeenCalledTimes(1);
    await h.navigated(1);
    h.land({ code: "c1", state: h.lastUrl().searchParams.get("state")! });
    expect(await a).toBe("sl-at1");
    expect(await b).toBe("sl-at1");
    expect(h.calls).toHaveLength(1);
  });

  test("a callback with someone else's state is not this grant's answer", async () => {
    const h = harness();
    const p = superlibraryAccessToken(PLANE, h.opts);
    await h.navigated(1);
    h.land({ code: "forged", state: "sl.not-ours" });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls).toHaveLength(0);
    h.land({ code: "c1", state: h.lastUrl().searchParams.get("state")! });
    expect(await p).toBe("sl-at1");
  });

  test("a blocked popup is a sentence, not a hang", async () => {
    const h = harness();
    h.open.mockReturnValueOnce(null);
    await expect(superlibraryAccessToken(PLANE, h.opts)).rejects.toThrow(/pop-up/i);
  });

  test("relaySuperlibraryCallback leaves the hub's own callback alone", () => {
    const h = harness();
    expect(relaySuperlibraryCallback("?code=x&state=hubstate", { channel: bus(), close: () => {}, navigate: () => {} })).toBe(false);
    expect(h.went).toEqual([]);
  });
});

describe("the plane needs the person (prompt=none answered login_required)", () => {
  test.each(["login_required", "interaction_required", "consent_required"])("%s: the same popup goes on to an interactive authorize, and the link resumes", async (error) => {
    const h = harness();
    const p = superlibraryAccessToken(PLANE, h.opts);
    await h.navigated(1);
    const silentState = h.lastUrl().searchParams.get("state")!;
    h.land({ error, state: silentState });
    await h.navigated(2);
    const u = h.lastUrl();
    expect(u.searchParams.get("prompt")).toBeNull();
    expect(u.searchParams.get("resource")).toBe(SUPERLIBRARY_AUDIENCE);
    const state = u.searchParams.get("state")!;
    expect(state).not.toBe(silentState);
    expect(h.win.closed).toBe(false); // the person is signing in there
    h.land({ code: "c2", state });
    expect(await p).toBe("sl-at1");
    expect(h.calls).toHaveLength(1);
  });

  test("login_required on the interactive authorize is a refusal, not a loop", async () => {
    const h = harness();
    const p = superlibraryAccessToken(PLANE, h.opts);
    await h.navigated(1);
    h.land({ error: "login_required", state: h.lastUrl().searchParams.get("state")! });
    await h.navigated(2);
    h.land({ error: "login_required", state: h.lastUrl().searchParams.get("state")! });
    await expect(p).rejects.toThrow(/Superlibrary/);
    expect(h.went).toHaveLength(2);
  });

  test("the person closing the popup ends the wait with a sentence", async () => {
    vi.useFakeTimers();
    const h = harness();
    const p = superlibraryAccessToken(PLANE, h.opts);
    const failed = expect(p).rejects.toThrow(/closed/i);
    await vi.advanceTimersByTimeAsync(10);
    h.win.closed = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
  });
});

describe("two separate grants", () => {
  test("Superlibrary refreshes with its own refresh token and resource; the hub's refresh token is never spent", async () => {
    await hubSignedIn();
    const { h } = await granted();
    const now = () => 299_000; // both access tokens nearly out
    const hubCalls: URLSearchParams[] = [];
    const hubFetch = (async (_u: string, init?: RequestInit) => {
      hubCalls.push(new URLSearchParams(String(init?.body)));
      return json(200, { access_token: "hub-at2", expires_in: 300, refresh_token: "hub-rt2" });
    }) as never;

    expect(await superlibraryAccessToken(PLANE, { ...h.opts, now })).toBe("sl-at2");
    expect(h.calls[1]).toMatchObject({ grant: "refresh_token", refresh: "sl-rt1", resource: SUPERLIBRARY_AUDIENCE });

    expect(await planeAccessToken(PLANE, { fetchFn: hubFetch, now })).toBe("hub-at2");
    expect(hubCalls[0]!.get("refresh_token")).toBe("hub-rt1"); // untouched by Superlibrary's refresh
    expect(hubCalls[0]!.get("resource")).toBe("https://hub.test");
    expect(h.calls).toHaveLength(2); // and the hub's refresh spent nothing of Superlibrary's
  });

  test("concurrent Superlibrary refreshes are one request (its own single-flight)", async () => {
    const { h } = await granted();
    const now = () => 299_000;
    const [a, b] = await Promise.all([superlibraryAccessToken(PLANE, { ...h.opts, now }), superlibraryAccessToken(PLANE, { ...h.opts, now })]);
    expect([a, b]).toEqual(["sl-at2", "sl-at2"]);
    expect(h.calls.filter((c) => c.grant === "refresh_token")).toHaveLength(1);
  });

  test("a network error on refresh is retried; the grant survives", async () => {
    const answers = [() => json(200, { access_token: "sl-at1", expires_in: 300, refresh_token: "sl-rt1" }), () => Promise.reject(new TypeError("offline")), () => json(503, {})];
    const { h } = await granted(harness(answers));
    expect(await superlibraryAccessToken(PLANE, { ...h.opts, now: () => 299_000 })).toBe("sl-at4");
    expect(h.calls.map((c) => c.refresh)).toEqual([null, "sl-rt1", "sl-rt1", "sl-rt1"]);
  });

  test("a network that stays down keeps the grant: the still-valid token answers, an expired one is a sentence", async () => {
    const down = () => Promise.reject(new TypeError("offline"));
    const { h } = await granted(harness([() => json(200, { access_token: "sl-at1", expires_in: 300, refresh_token: "sl-rt1" }), down, down, down, down, down, down]));
    expect(await superlibraryAccessToken(PLANE, { ...h.opts, now: () => 299_000 })).toBe("sl-at1");
    await expect(superlibraryAccessToken(PLANE, { ...h.opts, now: () => 301_000 })).rejects.toThrow(/unavailable/i);
    expect(hasSuperlibraryGrant()).toBe(true);
  });

  test("a refused Superlibrary refresh ends only that grant: the hub stays signed in, and the next click asks again", async () => {
    await hubSignedIn();
    const { h } = await granted(harness([() => json(200, { access_token: "sl-at1", expires_in: 300, refresh_token: "sl-rt1" }), () => json(400, { error: "invalid_grant" })]));
    await expect(superlibraryAccessToken(PLANE, { ...h.opts, now: () => 299_000 })).rejects.toThrow(/Link this file again/);
    expect(hasSuperlibraryGrant()).toBe(false);
    expect(hasTokens()).toBe(true);
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBe("hub-at1");
    superlibraryAccessToken(PLANE, h.opts).catch(() => {});
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  test("a 401 from Superlibrary drops its access token only: the hub is not signed out, and the next call refreshes", async () => {
    await hubSignedIn();
    const { token, h } = await granted();
    discardSuperlibraryAccess(token);
    expect(hasTokens()).toBe(true);
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBe("hub-at1");
    expect(await superlibraryAccessToken(PLANE, h.opts)).toBe("sl-at2");
    expect(h.calls[1]).toMatchObject({ grant: "refresh_token", refresh: "sl-rt1" });
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  test("a 401 from the hub (not a sign-out) leaves the Superlibrary grant alone", async () => {
    await hubSignedIn();
    const { h } = await granted();
    discardToken("hub-at1");
    signOutLocal();
    expect(hasTokens()).toBe(false);
    expect(await superlibraryAccessToken(PLANE, h.opts)).toBe("sl-at1");
  });
});

describe("explicit sign-out", () => {
  test("revokes Superlibrary's refresh token at the plane and forgets the grant", async () => {
    const { h } = await granted();
    const seen: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (u: string, init?: RequestInit) => {
      seen.push({ url: String(u), body: String(init?.body ?? "") });
      if (String(u).endsWith("/.well-known/oauth-authorization-server")) return json(200, { revocation_endpoint: "https://accounts.test/api/auth/oauth2/revoke" });
      return json(200, {});
    }) as never;
    await signOutOfSuperlibrary(PLANE, { fetchFn });
    expect(hasSuperlibraryGrant()).toBe(false);
    const revoke = seen.find((s) => s.url === "https://accounts.test/api/auth/oauth2/revoke")!;
    expect(new URLSearchParams(revoke.body).get("token")).toBe("sl-rt1");
    superlibraryAccessToken(PLANE, h.opts).catch(() => {});
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  test("a grant in flight at sign-out stores nothing", async () => {
    const h = harness();
    const p = superlibraryAccessToken(PLANE, h.opts);
    await h.navigated(1);
    const state = h.lastUrl().searchParams.get("state")!;
    await signOutOfSuperlibrary(PLANE, { fetchFn: (async () => json(404, {})) as never });
    await expect(p).rejects.toThrow();
    h.land({ code: "late", state });
    await new Promise((r) => setTimeout(r, 10));
    expect(hasSuperlibraryGrant()).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  test("a code exchange still in flight at sign-out stores nothing", async () => {
    let answer!: (r: Response) => void;
    const h = harness([() => new Promise<Response>((r) => (answer = r))]);
    const p = superlibraryAccessToken(PLANE, h.opts);
    const failed = expect(p).rejects.toThrow();
    await h.navigated(1);
    h.land({ code: "c1", state: h.lastUrl().searchParams.get("state")! });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    await signOutOfSuperlibrary(PLANE, { fetchFn: (async () => json(404, {})) as never });
    answer(json(200, { access_token: "late-at", expires_in: 300, refresh_token: "late-rt" }));
    await failed;
    await new Promise((r) => setTimeout(r, 10));
    expect(hasSuperlibraryGrant()).toBe(false);
  });
});
