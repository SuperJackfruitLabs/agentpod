/**
 * A full page load under the org plane starts with no token: the console keeps it in memory, so
 * the session has to be re-established. Staging, 2026-10-22: a full load of /nodes/<id> fired
 * `GET /api/nodes/<id>/stations` before that (hub: 401 "no valid org-plane token"), the page read
 * it as "Couldn't reach the hub", and never retried. Requests now wait for auth, and a request with
 * no token to send is a sign-in prompt, never a connection error.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as authStore from "$lib/stores/auth.svelte";
import { http, listStations } from "./client";
import { ApiError } from "./http-error";

const plane = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "hub" };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.setItem("agentpod.apiUrl", "https://hub.test");
  authStore.clearAuthSession();
});
afterEach(() => {
  authStore.clearAuthSession();
  localStorage.clear();
});

test("under the plane, a request made before auth is ready waits for it", async () => {
  authStore.setAuthApiUrl("https://hub.test");
  authStore.setPlane(plane);
  const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
  vi.spyOn(authStore, "getToken").mockResolvedValue("at1");

  let done = false;
  const p = listStations("node_1").then(() => (done = true));
  await flush();
  expect(f).not.toHaveBeenCalled();
  expect(done).toBe(false);

  // initAuth's own /api/me comes from the real store; any token will do here.
  f.mockResolvedValueOnce(new Response(JSON.stringify({ id: "u1", email: "a@b.c" }), { status: 200 }));
  await authStore.initAuth();
  await p;
  const urls = f.mock.calls.map((c) => String(c[0]));
  expect(urls).toContain("https://hub.test/api/nodes/node_1/stations");
  expect(new Headers(f.mock.calls.at(-1)![1]?.headers).get("authorization")).toBe("Bearer at1");
});

test("under the plane with no token to send, the error is a sign-in prompt and nothing is sent", async () => {
  authStore.setAuthApiUrl("https://hub.test");
  authStore.setPlane(plane);
  await authStore.initAuth(); // no token in memory: signed out, settled
  const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

  const err = await http("/api/nodes/node_1/stations").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(401);
  expect((err as ApiError).message).not.toMatch(/reach the hub/);
  expect((err as ApiError).message).toMatch(/sign in/i);
  expect(f).not.toHaveBeenCalled();
});

test("a hub 401 is a sign-in prompt, after one retry with a fresh token", async () => {
  authStore.setAuthApiUrl("https://hub.test");
  authStore.setPlane(plane);
  await authStore.initAuth();
  vi.spyOn(authStore, "getToken").mockResolvedValueOnce("old").mockResolvedValueOnce("new").mockResolvedValue("new");
  const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 401 }));

  const err = await http("/api/nodes").catch((e) => e);
  expect(f).toHaveBeenCalledTimes(2);
  expect(new Headers(f.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer new");
  expect((err as ApiError).status).toBe(401);
  expect((err as ApiError).message).toMatch(/sign in/i);
});

test("a 401 retried with a fresh token that works succeeds", async () => {
  authStore.setAuthApiUrl("https://hub.test");
  authStore.setPlane(plane);
  await authStore.initAuth();
  vi.spyOn(authStore, "getToken").mockResolvedValueOnce("old").mockResolvedValue("new");
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("", { status: 401 }))
    .mockResolvedValueOnce(new Response("[1]", { status: 200 }));
  expect(await http("/api/nodes")).toEqual([1]);
});

test("a real network failure keeps the connection message", async () => {
  authStore.setAuthApiUrl("https://hub.test");
  authStore.setPlane(plane);
  await authStore.initAuth();
  vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const err = await http("/api/nodes").catch((e) => e);
  expect((err as ApiError).status).toBeNull();
  expect((err as ApiError).message).toMatch(/reach the hub/);
});

test("legacy mode never waits", async () => {
  const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
  await http("/api/nodes");
  expect(f).toHaveBeenCalledWith("https://hub.test/api/nodes", { credentials: "include" });
});
