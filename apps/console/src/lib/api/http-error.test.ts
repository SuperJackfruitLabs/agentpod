import { test, expect } from "vitest";
import { apiError, networkError, ApiError, managedByPlaneUrl } from "./http-error";

test("apiError: 500 with empty body → friendly server copy, technical line in detail", async () => {
  const res = new Response(null, { status: 500 });
  const err = await apiError(res, "POST /api/runtimes");

  expect(err).toBeInstanceOf(ApiError);
  // Regression: "POST /api/runtimes → 500" used to BE the message users saw.
  expect(err.message).toBe("The hub hit an internal error. Try again in a moment.");
  expect(err.message).not.toMatch(/→|\/api\//);
  expect(err.detail).toBe("POST /api/runtimes → 500");
  expect(err.status).toBe(500);
});

test("apiError: prefers the hub's own JSON error message, cleaned into a sentence", async () => {
  const res = new Response(JSON.stringify({ error: "station is offline" }), { status: 409 });
  const err = await apiError(res, "POST /api/stations/s1/lifecycle");

  expect(err.message).toBe("Station is offline.");
});

test("apiError: 403 and 404 map to human copy", async () => {
  expect((await apiError(new Response(null, { status: 403 }), "GET /x")).message).toBe(
    "You don't have permission to do that.",
  );
  expect((await apiError(new Response(null, { status: 404 }), "GET /x")).message).toBe(
    "That wasn't found on the hub — it may have been removed.",
  );
});

test("apiError: never surfaces an HTML error page as the message", async () => {
  const res = new Response("<!DOCTYPE html><html><body>Bad gateway</body></html>", {
    status: 502,
  });
  const err = await apiError(res, "GET /api/nodes");

  expect(err.message).toBe("The hub hit an internal error. Try again in a moment.");
});

test("apiError: carries the hub's own refusal `code` alongside its message", async () => {
  // A refused declared-harness-config plan answers 400 with {error, code} —
  // the whole point of the eight distinct codes is that a caller can tell
  // them apart, which is lost if the client reads only `message`.
  const res = new Response(JSON.stringify({ error: "nobody has declared this setting", code: "NOTHING_DECLARED" }), {
    status: 400,
  });
  const err = await apiError(res, "POST /api/stations/s1/config/plan");

  expect(err.code).toBe("NOTHING_DECLARED");
  expect(err.message).toBe("Nobody has declared this setting.");
  expect(err.status).toBe(400);
});

test("apiError: no `code` field on the body → code stays undefined, not fabricated", async () => {
  const res = new Response(JSON.stringify({ error: "station is offline" }), { status: 409 });
  const err = await apiError(res, "POST /api/stations/s1/lifecycle");

  expect(err.code).toBeUndefined();
});

test("networkError: fetch failure → reachability copy with cause in detail", () => {
  const err = networkError("GET /api/fleet/agents", new TypeError("Failed to fetch"));

  expect(err.message).toBe("Couldn't reach the hub — check your connection.");
  expect(err.status).toBeNull();
  expect(err.detail).toContain("Failed to fetch");
});

// ── Under the org plane (P3 Task 15): routes the plane now owns answer 410 ──────

const managed = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 410, headers: { "content-type": "application/json" } });

test("apiError: 410 managed_by_org_plane reads as a sentence and carries the plane's url", async () => {
  const err = await apiError(managed({ error: "managed_by_org_plane", url: "https://accounts.test/workspaces" }), "GET /api/admin/users");
  expect(err.status).toBe(410);
  expect(err.code).toBe("managed_by_org_plane");
  expect(err.url).toBe("https://accounts.test/workspaces");
  expect(err.message).toBe("This is managed in your Super Jackfruit account.");
  expect(managedByPlaneUrl(err)).toBe("https://accounts.test/workspaces");
});

test("managedByPlaneUrl: only an http(s) url from a managed refusal; anything else is null", async () => {
  expect(managedByPlaneUrl(await apiError(managed({ error: "managed_by_org_plane", url: "javascript:alert(1)" }), "GET /x"))).toBeNull();
  expect(managedByPlaneUrl(await apiError(managed({ error: "gone" }), "GET /x"))).toBeNull();
  expect(managedByPlaneUrl(new Error("boom"))).toBeNull();
});
