import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { acpProxyRouter } from "../../src/routes/acp-proxy";

/**
 * A minimal app, per the repo rule that WS/gateway tests never import
 * src/index.ts — that would start the sweeper and the boot hooks.
 */
function appWith(user: { id: string } | undefined) {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", user as never);
      await next();
    })
    .route("/api", acpProxyRouter);
}

describe("GET /api/acp/proxy — gates before upgrading", () => {
  test("401 without a user", async () => {
    // The upgrade must be refused before any session is touched: an
    // unauthenticated socket that reached the agent could open sessions on
    // someone else's station.
    const res = await appWith(undefined).request("/api/acp/proxy?station=station_1");
    expect(res.status).toBe(401);
  });

  test("400 without a station", async () => {
    // Guessing which station an editor meant is worse than refusing.
    const res = await appWith({ id: "usr_1" }).request("/api/acp/proxy");
    expect(res.status).toBe(400);
  });

  test("the 400 says what is missing", async () => {
    const res = await appWith({ id: "usr_1" }).request("/api/acp/proxy");
    expect((await res.json()).error).toContain("station");
  });

  test("426 when authenticated and addressed but not a WebSocket upgrade", async () => {
    // A plain GET is a person poking the URL in a browser, not a bug. Saying
    // "upgrade required" is more use than a stack trace.
    const res = await appWith({ id: "usr_1" }).request("/api/acp/proxy?station=station_1");
    expect(res.status).toBe(426);
  });
});
