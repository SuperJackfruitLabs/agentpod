/**
 * ACP proxy socket — the hub end of Doors.
 *
 *   GET /api/acp/proxy?station=<id>
 *
 * Upgrades to a WebSocket carrying raw ACP frames and binds it to a hub-side
 * ACP agent. On the other end, `apn acp` pipes an editor's stdio without
 * parsing it, so an editor on a laptop can drive a station on a machine it
 * cannot reach — including behind CGNAT, because the node dials out.
 *
 * Auth mirrors every other hub route: `authMiddleware` accepts a bearer token
 * or `?token=`, which is how a WebSocket handshake authenticates at all — a
 * browser cannot set headers on an upgrade, and neither can most clients.
 *
 * Design: docs/superpowers/specs/2026-08-11-doors-acp-proxy-design.md
 */

import { Hono } from "hono";
import type { AuthUser } from "../auth/middleware";
import { upgradeWebSocket } from "../ws";
import { buildAcpAgent } from "../services/acp-agent";
import { webSocketStream } from "../services/acp-ws-stream";
import { createLogger } from "../utils/logger";

const log = createLogger("acp-proxy");

export const acpProxyRouter = new Hono().get("/acp/proxy", async (c, next) => {
  // Gate BEFORE upgrading. An unauthenticated socket that reached the agent
  // could open sessions on someone else's station, and a missing station id
  // would leave us guessing which machine an editor meant.
  const user = c.get("user") as AuthUser | undefined;
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const stationId = c.req.query("station");
  if (!stationId) return c.json({ error: "A station query parameter is required." }, 400);

  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    // Someone opened the URL in a browser. Say so rather than failing oddly.
    return c.json({ error: "This endpoint requires a WebSocket upgrade." }, 426);
  }

  return upgradeWebSocket(() => {
    // Captured at upgrade time — `c` is not available inside the callbacks.
    const userId = user.id;
    let bridge: ReturnType<typeof webSocketStream> | undefined;

    return {
      onOpen(_evt: unknown, ws: { send(data: string): void }) {
        bridge = webSocketStream({ send: (d) => ws.send(d) });
        buildAcpAgent({ userId, stationId }).connect(bridge.stream);
        log.debug("acp proxy attached", { userId, stationId });
      },

      onMessage(evt: { data: unknown }) {
        // Raw ACP bytes from `apn acp`. Framing is ndJsonStream's problem:
        // socket message boundaries are not JSON boundaries.
        bridge?.push(typeof evt.data === "string" ? evt.data : String(evt.data));
      },

      onClose() {
        bridge?.close();
        log.debug("acp proxy detached", { userId, stationId });
      },
    };
  })(c, next);
});
