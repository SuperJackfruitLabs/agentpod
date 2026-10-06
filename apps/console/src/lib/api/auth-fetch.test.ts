/**
 * Every hub request carries the plane token under the org plane (P3 Task 15), and the Better Auth
 * cookie exactly as before in legacy mode.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as authStore from "$lib/stores/auth.svelte";
import { authFetch, http, readFile, readImage, socketToken, SOCKET_MIN_VALIDITY_SEC, withToken } from "./client";
import { listUsers } from "./admin";
import { fetchVoicePreview } from "./speech";

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.setItem("agentpod.apiUrl", "https://hub.test");
});
afterEach(() => localStorage.clear());

const bearerOf = (init: RequestInit | undefined) => new Headers(init?.headers).get("authorization");

describe("authFetch", () => {
  test("legacy: the cookie, exactly as today", async () => {
    vi.spyOn(authStore, "getToken").mockResolvedValue(null);
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await authFetch("https://hub.test/api/nodes");
    expect(f).toHaveBeenCalledWith("https://hub.test/api/nodes", { credentials: "include" });
  });

  test("plane: a bearer token and no cookie", async () => {
    vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await authFetch("https://hub.test/api/nodes", { method: "POST", headers: { "Content-Type": "application/json" } });
    const init = f.mock.calls[0]![1]!;
    expect(bearerOf(init)).toBe("Bearer at1");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.credentials).toBe("omit");
    expect(init.method).toBe("POST");
  });

  test("http() goes through authFetch", async () => {
    vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await http("/api/nodes");
    expect(bearerOf(f.mock.calls[0]![1])).toBe("Bearer at1");
  });

  test("file reads, admin calls and voice previews carry the token too", async () => {
    vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ users: [], total: 0 }), { status: 200 }),
    );
    await readFile("st_1", "/a");
    await readImage("st_1", "/a.png");
    await listUsers();
    await fetchVoicePreview("v1");
    expect(f).toHaveBeenCalledTimes(4);
    for (const [, init] of f.mock.calls) {
      expect(bearerOf(init)).toBe("Bearer at1");
      expect(init?.credentials).toBe("omit");
    }
  });

  test("legacy: file reads, admin calls and voice previews still send the cookie", async () => {
    vi.spyOn(authStore, "getToken").mockResolvedValue(null);
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ users: [], total: 0 }), { status: 200 }),
    );
    await readFile("st_1", "/a");
    await readImage("st_1", "/a.png");
    await listUsers();
    await fetchVoicePreview("v1");
    for (const [, init] of f.mock.calls) {
      expect(init?.credentials).toBe("include");
      expect(bearerOf(init)).toBeNull();
    }
  });
});

describe("withToken", () => {
  test("encodes and only appends when there is a token", () => {
    expect(withToken("wss://h/x", null)).toBe("wss://h/x");
    expect(withToken("wss://h/x", "a.b+c")).toBe("wss://h/x?token=a.b%2Bc");
    expect(withToken("https://h/x?y=1", "t")).toBe("https://h/x?y=1&token=t");
  });
});

describe("socketToken", () => {
  test("legacy: null at once, not a promise, so sockets open exactly as before", () => {
    vi.spyOn(authStore, "currentPlane").mockReturnValue(null);
    const get = vi.spyOn(authStore, "getToken");
    expect(socketToken()).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  test("plane: asks for a token that outlives the upgrade", async () => {
    vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
    const get = vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
    expect(await socketToken()).toBe("at1");
    expect(SOCKET_MIN_VALIDITY_SEC).toBeGreaterThanOrEqual(60);
    expect(get).toHaveBeenCalledWith(SOCKET_MIN_VALIDITY_SEC);
  });
});
