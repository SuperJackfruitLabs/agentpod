import { test, expect } from "vitest";
import { apiError, networkError, ApiError } from "./http-error";

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

test("networkError: fetch failure → reachability copy with cause in detail", () => {
  const err = networkError("GET /api/fleet/agents", new TypeError("Failed to fetch"));

  expect(err.message).toBe("Couldn't reach the hub — check your connection.");
  expect(err.status).toBeNull();
  expect(err.detail).toContain("Failed to fetch");
});
