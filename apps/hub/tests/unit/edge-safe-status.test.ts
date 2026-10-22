import { test, expect } from "bun:test";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { cors } from "hono/cors";
import { edgeSafeStatus } from "../../src/middleware/edge-safe-status";
import { stationFailure } from "../../src/services/station-failure";

// Spec 2026-10-23 C16: an edge replaces an origin 502/504 with CORS-less HTML, so the console
// shows "Couldn't reach the hub" for what was really a station failure. The hub never sends them.

function app() {
  return new Hono()
    .use("*", edgeSafeStatus)
    .use("*", cors({ origin: "https://console.example" }))
    .get("/bad-gateway", (c) => c.json({ error: "the node broke" }, 502))
    .get("/coded", (c) => c.json({ error: "x", code: "NODE_UNREACHABLE" }, 502))
    .get("/timeout", (c) => c.json({ error: "slow" }, 504))
    .get("/text", (c) => c.text("upstream died", 502))
    .get("/ok", (c) => c.json({ fine: true }, 200))
    .get("/forbidden", (c) => c.json({ error: "no" }, 403));
}

const get = (path: string) =>
  app().request(path, { headers: { Origin: "https://console.example" } });

test("a 502 becomes 424 node_failed, keeping the message and the CORS headers", async () => {
  const res = await get("/bad-gateway");
  expect(res.status).toBe(424);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://console.example");
  expect(await res.json()).toEqual({ error: "the node broke", code: "node_failed" });
});

test("a route's own code survives the rewrite", async () => {
  const res = await get("/coded");
  expect(res.status).toBe(424);
  expect(await res.json()).toEqual({ error: "x", code: "NODE_UNREACHABLE" });
});

test("a 504 becomes 503 station_unavailable", async () => {
  const res = await get("/timeout");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "slow", code: "station_unavailable" });
});

test("a plain-text 502 becomes the JSON envelope", async () => {
  const res = await get("/text");
  expect(res.status).toBe(424);
  expect(await res.json()).toEqual({ error: "upstream died", code: "node_failed" });
});

test("other statuses pass through untouched", async () => {
  expect((await get("/ok")).status).toBe(200);
  const res = await get("/forbidden");
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "no" });
});

test("the hub app mounts the rewrite ahead of CORS, so every route is covered", () => {
  const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  const edge = src.indexOf(".use('*', edgeSafeStatus)");
  const corsAt = src.indexOf(".use('*', corsMiddleware)");
  expect(edge).toBeGreaterThan(-1);
  expect(edge).toBeLessThan(corsAt);
});

test("stationFailure: transport failures are 503 station_unavailable, the rest 424 node_failed", () => {
  for (const e of ["node offline", "node disconnected", "timeout"]) {
    expect(stationFailure(e, "x")).toEqual({ status: 503, body: { error: e, code: "station_unavailable" } });
  }
  expect(stationFailure("salaam: nope", "x")).toEqual({
    status: 424,
    body: { error: "salaam: nope", code: "node_failed" },
  });
  expect(stationFailure(undefined, "fs.list failed").body.error).toBe("fs.list failed");
});
