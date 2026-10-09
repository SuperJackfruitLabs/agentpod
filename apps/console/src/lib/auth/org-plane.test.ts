import { beforeEach, describe, expect, test, vi } from "vitest";
import { afterEach } from "vitest";
import { abandonPendingSignIn, autoSignIn, beginSignIn, completeSignIn, discardSuperlibraryToken, discardToken, discoverPlane, hasTokens, planeAccessToken, resetPageLoadState, signOut, signOutLocal, superlibraryAccessToken, suppressAutoSignIn, userSignedOut, watchSession } from "./org-plane";

const PLANE = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.test" };
const ORIGIN = "https://console.test";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  signOutLocal();
  abandonPendingSignIn();
  resetPageLoadState();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Signed in through a full authorize + callback, with tokens issued at t=0 for 300 s. */
async function signIn(tokens = { access_token: "at1", expires_in: 300, refresh_token: "rt1" }) {
  let went = "";
  await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
  const state = new URL(went).searchParams.get("state")!;
  resetPageLoadState(); // the plane sends the browser back: /auth/callback is a new page load
  await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, {
    origin: ORIGIN, now: () => 0,
    fetchFn: (async () => json(200, tokens)) as never,
  });
}

describe("discoverPlane", () => {
  test("null issuer and a 404 (older hub) both mean legacy", async () => {
    expect(await discoverPlane("https://hub.test", async () => json(200, { issuer: null }))).toBeNull();
    expect(await discoverPlane("https://hub.test", async () => json(404, {}))).toBeNull();
  });
  test("an unreachable hub, or a body that is not JSON, means legacy", async () => {
    expect(await discoverPlane("https://hub.test", async () => { throw new TypeError("offline"); })).toBeNull();
    expect(await discoverPlane("https://hub.test", async () => new Response("<html>", { status: 200 }))).toBeNull();
  });
  test("a configured hub names the plane", async () => {
    const seen: string[] = [];
    const out = await discoverPlane("https://hub.test/", async (u) => { seen.push(String(u)); return json(200, PLANE); });
    expect(out).toEqual(PLANE);
    expect(seen).toEqual(["https://hub.test/public/org-plane"]);
  });
});

describe("authorization code + PKCE", () => {
  test("beginSignIn sends client, redirect, S256 challenge, state and resource", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/nodes", origin: ORIGIN, navigate: (u) => (went = u) });
    const u = new URL(went);
    expect(u.origin + u.pathname).toBe("https://accounts.test/api/auth/oauth2/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "agentpod-console",
      redirect_uri: "https://console.test/auth/callback",
      code_challenge_method: "S256",
      resource: "https://hub.test",
    });
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  test("completeSignIn checks state, posts the verifier with resource, and holds the token in memory", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/nodes", origin: ORIGIN, navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    const fetchFn = vi.fn(async (u: string, init?: RequestInit) => {
      expect(u).toBe("https://accounts.test/api/auth/oauth2/token");
      const body = new URLSearchParams(String(init!.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("agentpod-console");
      expect(body.get("resource")).toBe("https://hub.test");
      expect(body.get("redirect_uri")).toBe("https://console.test/auth/callback");
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      return json(200, { access_token: "at1", token_type: "Bearer", expires_in: 300, refresh_token: "rt1" });
    });
    const out = await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, { origin: ORIGIN, fetchFn: fetchFn as never, now: () => 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ returnTo: "/nodes" });
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBe("at1");
    expect(JSON.stringify(sessionStorage)).not.toContain("rt1"); // the refresh token never leaves memory
    expect(Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)).join()).not.toMatch(/rt1|at1/);
    expect(Object.keys(localStorage).map((k) => localStorage.getItem(k)).join()).not.toMatch(/rt1|at1/);
  });

  test("a state mismatch is refused and no token request is made", async () => {
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: () => {} });
    const fetchFn = vi.fn();
    await expect(completeSignIn(new URLSearchParams({ code: "c", state: "forged" }), PLANE, { fetchFn: fetchFn as never })).rejects.toThrow(/state/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("a callback with no sign-in pending is refused", async () => {
    const fetchFn = vi.fn();
    await expect(completeSignIn(new URLSearchParams({ code: "c", state: "s" }), PLANE, { fetchFn: fetchFn as never })).rejects.toThrow(/state/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("an access token about to expire is refreshed with the rotating refresh token", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, {
      origin: ORIGIN, now: () => 0,
      fetchFn: (async () => json(200, { access_token: "at1", expires_in: 300, refresh_token: "rt1" })) as never,
    });
    const refresh = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init!.body));
      expect([body.get("grant_type"), body.get("refresh_token"), body.get("resource")]).toEqual(["refresh_token", "rt1", "https://hub.test"]);
      return json(200, { access_token: "at2", expires_in: 300, refresh_token: "rt2" });
    });
    expect(await planeAccessToken(PLANE, { now: () => 280_000, fetchFn: refresh as never })).toBe("at2");
    // The rotated refresh token is the one used next time.
    const again = vi.fn(async (_u: string, init?: RequestInit) => {
      expect(new URLSearchParams(String(init!.body)).get("refresh_token")).toBe("rt2");
      return json(200, { access_token: "at3", expires_in: 300, refresh_token: "rt3" });
    });
    expect(await planeAccessToken(PLANE, { now: () => 560_000, fetchFn: again as never })).toBe("at3");
  });

  test("concurrent callers near expiry share one refresh, so a rotating token is spent once", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, {
      origin: ORIGIN, now: () => 0,
      fetchFn: (async () => json(200, { access_token: "at1", expires_in: 300, refresh_token: "rt1" })) as never,
    });
    const refresh = vi.fn(async () => json(200, { access_token: "at2", expires_in: 300, refresh_token: "rt2" }));
    const opts = { now: () => 290_000, fetchFn: refresh as never };
    const got = await Promise.all([planeAccessToken(PLANE, opts), planeAccessToken(PLANE, opts), planeAccessToken(PLANE, opts)]);
    expect(got).toEqual(["at2", "at2", "at2"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a refused refresh signs out instead of returning a stale token", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, {
      origin: ORIGIN, now: () => 0,
      fetchFn: (async () => json(200, { access_token: "at1", expires_in: 300, refresh_token: "rt1" })) as never,
    });
    expect(await planeAccessToken(PLANE, { now: () => 290_000, fetchFn: (async () => json(400, { error: "invalid_grant" })) as never })).toBeNull();
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBeNull();
  });

  test("signOutLocal forgets the tokens", async () => {
    await signIn();
    signOutLocal();
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBeNull();
  });
});

// Found in production on 2026-10-07: opening Settings on a phone reloaded the tab, the layout's
// guard (a $effect, which re-runs) started a second sign-in while the first was still awaiting its
// PKCE challenge, the second overwrote the saved state, the browser followed the FIRST redirect,
// and the callback said "Sign-in state did not match".
describe("only one sign-in redirect per page", () => {
  test("two overlapping beginSignIn calls navigate once, and that redirect's state is the saved one", async () => {
    const went: string[] = [];
    const navigate = (u: string) => void went.push(u);
    await Promise.all([
      beginSignIn(PLANE, { returnTo: "/settings", origin: ORIGIN, navigate }),
      beginSignIn(PLANE, { returnTo: "/settings", origin: ORIGIN, navigate }),
    ]);
    expect(went).toHaveLength(1);
    const state = new URL(went[0]!).searchParams.get("state");
    expect(JSON.parse(sessionStorage.getItem("agentpod.pkce")!).state).toBe(state);
  });

  test("the guard firing twice still completes: the callback's state matches", async () => {
    const went: string[] = [];
    const navigate = (u: string) => void went.push(u);
    expect(autoSignIn(PLANE, "/settings", { origin: ORIGIN, navigate })).toBe(true);
    expect(autoSignIn(PLANE, "/settings", { origin: ORIGIN, navigate })).toBe(true); // still under way: not /login
    await vi.waitFor(() => expect(went.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(went).toHaveLength(1);
    const state = new URL(went[0]!).searchParams.get("state")!;
    const fetchFn = vi.fn(async () => json(200, { access_token: "at1", expires_in: 300, refresh_token: "rt1" }));
    const out = await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, { origin: ORIGIN, fetchFn: fetchFn as never, now: () => 0 });
    expect(out).toEqual({ returnTo: "/settings" });
  });
});

// Found in production on 2026-10-07, after the single-flight fix: on a fresh load the panes fetch
// before any token exists, the hub answers 401, and handleUnauthorized() -> clearAuthSession() ->
// signOutLocal() deleted the pending sign-in the guard had just saved. The plane came back with a
// code and a state, and the callback said "Sign-in state did not match".
describe("a 401 during sign-in does not abandon it", () => {
  test("signOutLocal (the 401 path) keeps the pending sign-in, so the callback still completes", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
    signOutLocal(); // a pane's 401 while the redirect is under way
    const state = new URL(went).searchParams.get("state")!;
    const fetchFn = vi.fn(async () => json(200, { access_token: "at1", expires_in: 300, refresh_token: "rt1" }));
    const out = await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, { origin: ORIGIN, fetchFn: fetchFn as never, now: () => 0 });
    expect(out).toEqual({ returnTo: "/" });
  });

  test("an explicit sign-out does abandon it: a late callback is refused", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
    await signOut(PLANE);
    const state = new URL(went).searchParams.get("state")!;
    const fetchFn = vi.fn();
    await expect(completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, { origin: ORIGIN, fetchFn: fetchFn as never })).rejects.toThrow(/state/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// Operator report, 2026-10-07: "I see the login screen most of the time even though
// accounts.superjackfruit.com is already logged in." The guard re-authorized only when a
// sessionStorage flag said THIS tab had signed in, so a new tab, a bookmark or a discarded mobile
// tab rendered /login; and every 401 cleared the flag.
describe("autoSignIn (the layout's guard, for a visitor with no token)", () => {
  test("a new tab with nothing stored goes straight to authorize, prompt=none, keeping where it was", async () => {
    let went = "";
    expect(autoSignIn(PLANE, "/nodes/n1", { origin: ORIGIN, navigate: (u) => (went = u) })).toBe(true);
    await vi.waitFor(() => expect(went).toContain("https://accounts.test/api/auth/oauth2/authorize?"));
    expect(new URL(went).searchParams.get("prompt")).toBe("none");
    expect(JSON.parse(sessionStorage.getItem("agentpod.pkce")!)).toMatchObject({ returnTo: "/nodes/n1", silent: true });
  });

  test("legacy mode (no plane) does not", () => {
    const navigate = vi.fn();
    expect(autoSignIn(null, "/", { origin: ORIGIN, navigate })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("after an explicit sign-out in this browser it does not: /login is shown", async () => {
    await signIn();
    await signOut(PLANE, { fetchFn: (async () => json(404, {})) as never });
    expect(localStorage.getItem("agentpod.planeSignedOut")).toBe("1");
    resetPageLoadState(); // a later page load, or another tab
    const navigate = vi.fn();
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("an interactive sign-in afterwards clears the signed-out marker", async () => {
    localStorage.setItem("agentpod.planeSignedOut", "1");
    await signIn();
    expect(userSignedOut()).toBe(false);
    expect(localStorage.getItem("agentpod.planeSignedOut")).toBeNull();
  });

  test("a 401 (signOutLocal / discardToken) is not a sign-out: no marker, and the guard still re-authorizes", async () => {
    await signIn();
    discardToken("at1");
    signOutLocal();
    expect(localStorage.getItem("agentpod.planeSignedOut")).toBeNull();
    const navigate = vi.fn();
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate })).toBe(true);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  });

  test("a failed callback suppresses it for the rest of the page load: no redirect loop", () => {
    suppressAutoSignIn();
    const navigate = vi.fn();
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("a failed callback (state mismatch, plane error) suppresses it", async () => {
    await expect(completeSignIn(new URLSearchParams({ error: "access_denied" }), PLANE, { fetchFn: vi.fn() as never })).rejects.toThrow(/access_denied/);
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate: vi.fn() })).toBe(false);
    resetPageLoadState();
    await expect(completeSignIn(new URLSearchParams({ code: "c", state: "forged" }), PLANE, { fetchFn: vi.fn() as never })).rejects.toThrow(/state/);
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate: vi.fn() })).toBe(false);
  });

  test("an attempt that cannot even start reports failure once and does not retry this page load", async () => {
    const onError = vi.fn();
    const navigate = vi.fn(() => { throw new Error("blocked"); });
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate, onError })).toBe(true);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate })).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
  });

  test("a guard that re-runs while the attempt is under way is not counted as another attempt", () => {
    for (let i = 0; i < 5; i++) expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate: () => {} })).toBe(true);
    resetPageLoadState(); // the next page load is still allowed its automatic attempt
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate: () => {} })).toBe(true);
  });

  test("across page loads, three automatic attempts inside a minute stop the fourth (a loop)", () => {
    let t = 1_000_000;
    const now = () => t;
    for (let i = 0; i < 3; i++) {
      resetPageLoadState();
      expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate: () => {}, now })).toBe(true);
      t += 5_000;
    }
    resetPageLoadState();
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate: () => {}, now })).toBe(false);
    t += 60_000; // the loop has stopped; a later reload tries again
    resetPageLoadState();
    expect(autoSignIn(PLANE, "/", { origin: ORIGIN, navigate: () => {}, now })).toBe(true);
  });
});

describe("a silent authorize the plane cannot answer silently", () => {
  for (const error of ["login_required", "interaction_required", "consent_required"]) {
    test(`${error} asks for an interactive authorize instead of failing`, async () => {
      let went = "";
      autoSignIn(PLANE, "/runtimes", { origin: ORIGIN, navigate: (u) => (went = u) });
      await vi.waitFor(() => expect(went).toBeTruthy());
      const state = new URL(went).searchParams.get("state")!;
      resetPageLoadState(); // the callback is a new page load
      const out = await completeSignIn(new URLSearchParams({ error, state }), PLANE, { origin: ORIGIN, fetchFn: vi.fn() as never });
      expect(out).toEqual({ returnTo: "/runtimes", interactive: true });
      // The interactive authorize carries no prompt=none, so the plane shows its sign-in page.
      let again = "";
      await beginSignIn(PLANE, { returnTo: out.returnTo, origin: ORIGIN, navigate: (u) => (again = u) });
      expect(new URL(again).searchParams.get("prompt")).toBeNull();
    });
  }

  test("login_required on an INTERACTIVE authorize is an error, not another redirect", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    await expect(completeSignIn(new URLSearchParams({ error: "login_required", state }), PLANE, { origin: ORIGIN })).rejects.toThrow(/login_required/);
  });

  test("login_required with a forged state is refused", async () => {
    autoSignIn(PLANE, "/", { origin: ORIGIN, navigate: () => {} });
    await vi.waitFor(() => expect(sessionStorage.getItem("agentpod.pkce")).toBeTruthy());
    await expect(completeSignIn(new URLSearchParams({ error: "login_required", state: "forged" }), PLANE, { origin: ORIGIN })).rejects.toThrow();
  });
});

describe("refresh survives a bad network; only a refusal ends the session", () => {
  test("a network error near expiry keeps the still-valid token and retries with backoff", async () => {
    vi.useFakeTimers();
    await signIn();
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(json(200, { access_token: "at2", expires_in: 300, refresh_token: "rt2" }));
    const now = () => 290_000; // 10 s left
    expect(await planeAccessToken(PLANE, { now, fetchFn: fetchFn as never })).toBe("at1");
    expect(hasTokens()).toBe(true);
    // Inside the backoff, a caller gets the valid token without another request.
    expect(await planeAccessToken(PLANE, { now, fetchFn: fetchFn as never })).toBe("at1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const body = new URLSearchParams(String(fetchFn.mock.calls[1]![1].body));
    expect(body.get("refresh_token")).toBe("rt1");
    expect(await planeAccessToken(PLANE, { now })).toBe("at2");
  });

  test("a 5xx is transient too", async () => {
    await signIn();
    expect(await planeAccessToken(PLANE, { now: () => 290_000, fetchFn: (async () => json(503, {})) as never })).toBe("at1");
    expect(hasTokens()).toBe(true);
  });

  test("an expired token with the network down answers null but keeps the refresh token for later", async () => {
    await signIn();
    expect(await planeAccessToken(PLANE, { now: () => 400_000, fetchFn: (async () => { throw new TypeError("offline"); }) as never })).toBeNull();
    expect(hasTokens()).toBe(true);
    // An expired token is refreshed at once, backoff or not: the caller has nothing else to send.
    const ok = vi.fn(async () => json(200, { access_token: "at2", expires_in: 300, refresh_token: "rt2" }));
    expect(await planeAccessToken(PLANE, { now: () => 400_500, fetchFn: ok as never })).toBe("at2"); // inside the 1 s backoff
  });

  for (const [status, error] of [[400, "invalid_grant"], [401, "invalid_client"]] as const) {
    test(`HTTP ${status} ${error} ends the session and is never retried`, async () => {
      vi.useFakeTimers();
      await signIn();
      const fetchFn = vi.fn(async () => json(status, { error }));
      expect(await planeAccessToken(PLANE, { now: () => 290_000, fetchFn: fetchFn as never })).toBeNull();
      expect(hasTokens()).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(userSignedOut()).toBe(false); // a dead grant is not the person signing out
    });
  }

  for (const event of ["online", "visibilitychange"] as const) {
    test(`${event} refreshes a token near expiry at once, skipping the backoff`, async () => {
      vi.useFakeTimers();
      await signIn();
      const now = () => 290_000;
      expect(await planeAccessToken(PLANE, { now, fetchFn: (async () => { throw new TypeError("offline"); }) as never })).toBe("at1");
      const fetchFn = vi.fn(async () => json(200, { access_token: "at2", expires_in: 300, refresh_token: "rt2" }));
      const stop = watchSession(() => PLANE, { target: window, now, fetchFn: fetchFn as never });
      try {
        (event === "online" ? window : document).dispatchEvent(new Event(event));
        await vi.advanceTimersByTimeAsync(0); // well inside the 1 s backoff
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(await planeAccessToken(PLANE, { now })).toBe("at2");
      } finally {
        stop();
      }
    });
  }

  test("another tab's explicit sign-out signs this tab out too", async () => {
    await signIn();
    const onSignedOut = vi.fn();
    const stop = watchSession(() => PLANE, { target: window, onSignedOut });
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: "agentpod.planeSignedOut", newValue: "1" }));
      expect(onSignedOut).toHaveBeenCalledOnce();
      expect(hasTokens()).toBe(false);
    } finally {
      stop();
    }
  });
});

describe("discardToken (a 401 from the hub)", () => {
  test("drops the tokens when the hub refused the one this tab holds", async () => {
    await signIn();
    discardToken("at1");
    expect(hasTokens()).toBe(false);
  });

  test("keeps them when the refused request carried no token or an older one", async () => {
    await signIn();
    discardToken(null); // sent while a refresh was failing: the refresh token is still good
    discardToken("at0");
    expect(hasTokens()).toBe(true);
  });
});

// Security review finding 6: the plane URL the hub names is where the browser is sent to sign in.
// https only, plain http only for a loopback host — the hub's own rule for ORG_PLANE_URL.
describe("the plane URL must be https", () => {
  test("discoverPlane treats a non-https plane URL as no plane at all", async () => {
    for (const url of ["http://accounts.test", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "accounts.test"]) {
      expect(await discoverPlane("https://hub.test", async () => json(200, { ...PLANE, url }))).toBeNull();
    }
    for (const url of ["https://accounts.test", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      expect(await discoverPlane("https://hub.test", async () => json(200, { ...PLANE, url }))).not.toBeNull();
    }
  });

  test("beginSignIn refuses to navigate anywhere but an https plane", async () => {
    const navigate = vi.fn();
    for (const url of ["javascript:alert(1)", "http://accounts.test", ""]) {
      await expect(beginSignIn({ ...PLANE, url }, { returnTo: "/", origin: ORIGIN, navigate })).rejects.toThrow(/https/);
    }
    expect(navigate).not.toHaveBeenCalled();
  });
});

// Security review finding 7a: logging out revokes the refresh token at the plane (RFC 7009, at
// the revocation endpoint the plane's discovery names), and memory is cleared whatever happens.
describe("signOut", () => {
  async function signedIn() {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, {
      origin: ORIGIN, now: () => 0,
      fetchFn: (async () => json(200, { access_token: "at1", expires_in: 300, refresh_token: "rt1" })) as never,
    });
  }

  test("revokes the refresh token at the discovered revocation endpoint and forgets everything", async () => {
    await signedIn();
    const calls: Array<{ url: string; body: string | null }> = [];
    const fetchFn = vi.fn(async (u: string, init?: RequestInit) => {
      calls.push({ url: String(u), body: init?.body ? String(init.body) : null });
      if (String(u) === "https://accounts.test/.well-known/oauth-authorization-server") {
        return json(200, { issuer: "https://accounts.test", revocation_endpoint: "https://accounts.test/api/auth/oauth2/revoke" });
      }
      return new Response(null, { status: 200 });
    });
    await signOut(PLANE, { fetchFn: fetchFn as never });
    expect(calls.map((c) => c.url)).toEqual([
      "https://accounts.test/.well-known/oauth-authorization-server",
      "https://accounts.test/api/auth/oauth2/revoke",
    ]);
    const body = new URLSearchParams(calls[1]!.body!);
    expect(Object.fromEntries(body)).toEqual({ token: "rt1", token_type_hint: "refresh_token", client_id: "agentpod-console" });
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBeNull();
    expect(userSignedOut()).toBe(true); // the person chose it: no silent sign-in straight back
  });

  test("memory is cleared even when the plane is unreachable", async () => {
    await signedIn();
    await signOut(PLANE, { fetchFn: (async () => { throw new TypeError("offline"); }) as never });
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBeNull();
  });

  test("a revocation endpoint off the plane's origin is not sent the token", async () => {
    await signedIn();
    const fetchFn = vi.fn(async (u: string) =>
      String(u).endsWith("/.well-known/oauth-authorization-server")
        ? json(200, { revocation_endpoint: "https://evil.test/revoke" })
        : new Response(null, { status: 200 }),
    );
    await signOut(PLANE, { fetchFn: fetchFn as never });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("a refresh still in flight at logout does not bring the tokens back", async () => {
    await signedIn();
    let finish!: (r: Response) => void;
    const slow = vi.fn(() => new Promise<Response>((r) => (finish = r)));
    const pending = planeAccessToken(PLANE, { now: () => 290_000, fetchFn: slow as never });
    await signOut(PLANE, { fetchFn: (async () => json(404, {})) as never });
    finish(json(200, { access_token: "at2", expires_in: 300, refresh_token: "rt2" }));
    await pending;
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBeNull();
  });
});

// Task A9R: the console's second audience. Superlibrary is called with the person's own token for
// it, minted from the same rotating refresh token as the hub's — so the two refreshes must never
// spend that token at the same time.
describe("a Superlibrary-audience token from the same refresh token", () => {
  const SL = "https://app.superlibrary.dev";

  /**
   * A plane that rotates refresh tokens: `rtN` buys `rtN+1`, and a token spent once is refused
   * (400 invalid_grant), as a reuse-detecting plane does. Every answer waits 5 ms, so two
   * requests that are not serialised really are in flight together.
   */
  function rotatingPlane() {
    const spent = new Set<string>();
    const seen: { refresh: string; resource: string }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init!.body));
      const refresh = body.get("refresh_token")!;
      const resource = body.get("resource")!;
      seen.push({ refresh, resource });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (spent.has(refresh)) return json(400, { error: "invalid_grant" });
      spent.add(refresh);
      const n = Number(refresh.slice(2)) + 1;
      const access = resource === SL ? `sl${n}` : `at${n}`;
      return json(200, { access_token: access, expires_in: 300, refresh_token: `rt${n}` });
    });
    return { fetchFn, seen, maxInFlight: () => maxInFlight };
  }

  test("asks for the Superlibrary audience with the refresh token, and keeps the rotated one", async () => {
    await signIn();
    const plane = rotatingPlane();
    const got = await superlibraryAccessToken(PLANE, { now: () => 1_000, fetchFn: plane.fetchFn as never });
    expect(got).toBe("sl2");
    expect(plane.seen).toEqual([{ refresh: "rt1", resource: SL }]);
    const body = new URLSearchParams(String(plane.fetchFn.mock.calls[0]![1]!.body));
    expect([body.get("grant_type"), body.get("client_id")]).toEqual(["refresh_token", "agentpod-console"]);
    // The hub's token is untouched: the Superlibrary token is never handed to the hub.
    expect(await planeAccessToken(PLANE, { now: () => 1_000 })).toBe("at1");
    // The rotated refresh token is what the hub's next refresh spends.
    expect(await planeAccessToken(PLANE, { now: () => 290_000, fetchFn: plane.fetchFn as never })).toBe("at3");
    expect(plane.seen[1]).toEqual({ refresh: "rt2", resource: "https://hub.test" });
  });

  test("is cached until near expiry, then refreshed again", async () => {
    await signIn();
    const plane = rotatingPlane();
    expect(await superlibraryAccessToken(PLANE, { now: () => 1_000, fetchFn: plane.fetchFn as never })).toBe("sl2");
    expect(await superlibraryAccessToken(PLANE, { now: () => 200_000, fetchFn: plane.fetchFn as never })).toBe("sl2");
    expect(plane.fetchFn).toHaveBeenCalledTimes(1);
    expect(await superlibraryAccessToken(PLANE, { now: () => 290_000, fetchFn: plane.fetchFn as never })).toBe("sl3");
    expect(plane.seen.map((s) => s.refresh)).toEqual(["rt1", "rt2"]);
  });

  test("a hub refresh and a Superlibrary refresh at once spend the rotating token one at a time", async () => {
    await signIn();
    const plane = rotatingPlane();
    const opts = { now: () => 290_000, fetchFn: plane.fetchFn as never };
    const [hub, library] = await Promise.all([planeAccessToken(PLANE, opts), superlibraryAccessToken(PLANE, opts)]);
    expect(hub).toBe("at2");
    expect(library).toBe("sl3");
    expect(plane.maxInFlight()).toBe(1);
    // The second request used the token the first one rotated in, not the spent one.
    expect(plane.seen.map((s) => s.refresh)).toEqual(["rt1", "rt2"]);
    expect(await planeAccessToken(PLANE, { now: () => 290_000 })).toBe("at2"); // still signed in
  });

  test("the other way round as well: Superlibrary first, the hub while it is in flight", async () => {
    await signIn();
    const plane = rotatingPlane();
    const opts = { now: () => 290_000, fetchFn: plane.fetchFn as never };
    const library = superlibraryAccessToken(PLANE, opts);
    const hub = planeAccessToken(PLANE, opts);
    expect(await library).toBe("sl2");
    expect(await hub).toBe("at3");
    expect(plane.maxInFlight()).toBe(1);
    expect(plane.seen).toEqual([{ refresh: "rt1", resource: SL }, { refresh: "rt2", resource: "https://hub.test" }]);
  });

  test("two Superlibrary needs at once share one refresh", async () => {
    await signIn();
    const plane = rotatingPlane();
    const opts = { now: () => 1_000, fetchFn: plane.fetchFn as never };
    expect(await Promise.all([superlibraryAccessToken(PLANE, opts), superlibraryAccessToken(PLANE, opts)])).toEqual(["sl2", "sl2"]);
    expect(plane.fetchFn).toHaveBeenCalledTimes(1);
  });

  test("signed out: no token, and no request", async () => {
    const fetchFn = vi.fn();
    expect(await superlibraryAccessToken(PLANE, { now: () => 0, fetchFn: fetchFn as never })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("signing out forgets the Superlibrary token too", async () => {
    await signIn();
    const plane = rotatingPlane();
    expect(await superlibraryAccessToken(PLANE, { now: () => 1_000, fetchFn: plane.fetchFn as never })).toBe("sl2");
    signOutLocal();
    expect(await superlibraryAccessToken(PLANE, { now: () => 1_000, fetchFn: plane.fetchFn as never })).toBeNull();
  });

  test("a refusal for Superlibrary says so and leaves the hub session alone", async () => {
    await signIn();
    const fetchFn = vi.fn(async () => json(400, { error: "invalid_target" }));
    await expect(superlibraryAccessToken(PLANE, { now: () => 1_000, fetchFn: fetchFn as never })).rejects.toThrow(/Superlibrary/);
    expect(await planeAccessToken(PLANE, { now: () => 1_000 })).toBe("at1");
  });

  test("a token Superlibrary refused is dropped, so the next need refreshes", async () => {
    await signIn();
    const plane = rotatingPlane();
    expect(await superlibraryAccessToken(PLANE, { now: () => 1_000, fetchFn: plane.fetchFn as never })).toBe("sl2");
    discardSuperlibraryToken("sl-older"); // not the one held: kept
    expect(await superlibraryAccessToken(PLANE, { now: () => 1_000, fetchFn: plane.fetchFn as never })).toBe("sl2");
    discardSuperlibraryToken("sl2");
    expect(await superlibraryAccessToken(PLANE, { now: () => 1_000, fetchFn: plane.fetchFn as never })).toBe("sl3");
    expect(await planeAccessToken(PLANE, { now: () => 1_000 })).toBe("at1"); // the hub's is untouched
  });
});
