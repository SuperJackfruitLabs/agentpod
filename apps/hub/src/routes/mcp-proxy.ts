/**
 * The node's loopback MCP proxy, managed from the hub — `fleet mcp-proxy`.
 *
 *   GET  /api/fleet/mcp-proxy[?nodeId=]   every station: declared, served, state (drift included)
 *   POST /api/fleet/mcp-proxy             { action: enable|disable, stationIds | allEligible, nodeId? }
 *   POST /api/fleet/mcp-proxy/rotate      { stationIds } | { nodeId }
 *   GET  /api/stations/:id/mcp-proxy      one station, for the console
 *
 * Behind `authMiddleware` like every operator route: a person acting on stations they own. The
 * rules live in `services/mcp-proxy.ts`.
 */

import { Hono } from "hono";
import { McpProxyChangeRequest, McpProxyRotateRequest } from "@agentpod/contract";

import { changeProxy, fleetView, oneStation, rotateProxy } from "../services/mcp-proxy";
import type { AuthUser } from "../auth/middleware";

function caller(c: { get: (k: "user") => unknown }): AuthUser | null {
  const user = c.get("user") as AuthUser | undefined;
  return user && user.id !== "anonymous" ? user : null;
}

async function bodyOf(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function createMcpProxyRoutes() {
  return new Hono()
    .get("/fleet/mcp-proxy", async (c) => {
      const user = caller(c);
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      return c.json(await fleetView(user.id, c.req.query("nodeId") || undefined));
    })
    .post("/fleet/mcp-proxy", async (c) => {
      const user = caller(c);
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const parsed = McpProxyChangeRequest.safeParse(await bodyOf(c.req.raw));
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      const out = await changeProxy(user.id, parsed.data);
      return c.json(out.body as Record<string, unknown>, out.status);
    })
    .post("/fleet/mcp-proxy/rotate", async (c) => {
      const user = caller(c);
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const parsed = McpProxyRotateRequest.safeParse(await bodyOf(c.req.raw));
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      const out = await rotateProxy(user.id, parsed.data);
      return c.json(out.body as Record<string, unknown>, out.status);
    })
    .get("/stations/:id/mcp-proxy", async (c) => {
      const user = caller(c);
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const view = await oneStation(user.id, c.req.param("id"));
      if (!view) return c.json({ error: "Not Found" }, 404);
      return c.json(view);
    });
}
