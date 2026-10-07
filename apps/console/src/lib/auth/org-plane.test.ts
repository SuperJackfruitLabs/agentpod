import { beforeEach, describe, expect, test, vi } from "vitest";
import { abandonPendingSignIn, beginSignIn, completeSignIn, discoverPlane, planeAccessToken, reauthorizeIfSignedIn, signOut, signOutLocal, wasSignedIn } from "./org-plane";

const PLANE = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.test" };
const ORIGIN = "https://console.test";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sessionStorage.clear();
  signOutLocal();
  abandonPendingSignIn();
});

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
    expect(wasSignedIn()).toBe(true);
    expect(JSON.stringify(sessionStorage)).not.toContain("rt1"); // the refresh token never leaves memory
    expect(Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)).join()).not.toMatch(/rt1|at1/);
    expect(Object.keys(localStorage).map((k) => localStorage.getItem(k)).join()).not.toMatch(/rt1|at1/);
  });

  test("a state mismatch is refused and no token request is made", async () => {
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: () => {} });
    const fetchFn = vi.fn();
    sessionStorage.setItem("agentpod.planeSignedIn", "1");
    await expect(completeSignIn(new URLSearchParams({ code: "c", state: "forged" }), PLANE, { fetchFn: fetchFn as never })).rejects.toThrow(/state/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(wasSignedIn()).toBe(false); // so the layout goes to /login, not into another authorize
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

  test("signOutLocal forgets tokens and the signed-in flag", async () => {
    signOutLocal();
    expect(await planeAccessToken(PLANE)).toBeNull();
    expect(wasSignedIn()).toBe(false);
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
    sessionStorage.setItem("agentpod.planeSignedIn", "1");
    const went: string[] = [];
    const navigate = (u: string) => void went.push(u);
    reauthorizeIfSignedIn(PLANE, "/settings", { origin: ORIGIN, navigate });
    reauthorizeIfSignedIn(PLANE, "/settings", { origin: ORIGIN, navigate });
    await vi.waitFor(() => expect(went.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
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

describe("reauthorizeIfSignedIn (the layout's guard, after a reload)", () => {
  test("a tab that had signed in goes back to authorize, silently, keeping where it was", async () => {
    sessionStorage.setItem("agentpod.planeSignedIn", "1");
    let went = "";
    expect(reauthorizeIfSignedIn(PLANE, "/nodes/n1", { origin: ORIGIN, navigate: (u) => (went = u) })).toBe(true);
    await vi.waitFor(() => expect(went).toContain("https://accounts.test/api/auth/oauth2/authorize?"));
    expect(JSON.parse(sessionStorage.getItem("agentpod.pkce")!).returnTo).toBe("/nodes/n1");
  });

  test("a tab that never signed in, or legacy mode, goes to /login instead", () => {
    const navigate = vi.fn();
    expect(reauthorizeIfSignedIn(PLANE, "/", { origin: ORIGIN, navigate })).toBe(false);
    sessionStorage.setItem("agentpod.planeSignedIn", "1");
    expect(reauthorizeIfSignedIn(null, "/", { origin: ORIGIN, navigate })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
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
    expect(wasSignedIn()).toBe(false);
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
