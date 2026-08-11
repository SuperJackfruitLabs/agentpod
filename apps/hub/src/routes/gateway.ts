/**
 * Node Gateway WebSocket Route
 *
 * Node-agents dial in over WSS using long-term credentials.
 * Endpoint: GET /public/nodes/gateway (WebSocket upgrade)
 *
 * Auth: Authorization: Bearer <nodeId>:<nodeSecret>
 * On open:       register + set online
 * On heartbeat:  refresh online + ack
 * On close:      unregister + set offline
 */

import { Hono } from "hono";
import { GatewayClientMessage } from "@agentpod/contract";
import { verifyNodeCredential } from "../services/enrollment";
import { setNodeStatus, setNodeAgentVersion } from "../services/node-registry";
import { connectionManager } from "../services/connection-manager";
import type { Send } from "../services/connection-manager";
import { handleNodeMessage, dropNode } from "../services/broker";
import { upgradeWebSocket } from "../ws";
import { autoAdoptProvisionedHarness } from "../services/runtime-autoadopt";
import { refreshAdoptedCapabilities } from "../services/station-registry";
import { recordHealth, clearNode } from "../services/health-cache";

// Node connects with `Authorization: Bearer <nodeId>:<nodeSecret>`.
export const gatewayRoutes = new Hono().get(
  "/gateway",
  upgradeWebSocket((c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/, "");
    const colonIdx = token.indexOf(":");
    const nodeId = colonIdx !== -1 ? token.slice(0, colonIdx) : token;
    const nodeSecret = colonIdx !== -1 ? token.slice(colonIdx + 1) : "";
    let authed: string | null = null;
    // This connection's send fn — its identity is the connection epoch.
    let send: Send | null = null;
    // Resolves true once auth completes, false if the connection is rejected or
    // closed first. onMessage awaits this so an early frame — notably the
    // one-shot `hello` the agent sends immediately on connect, which carries the
    // agent version — is processed after auth instead of being dropped mid-auth.
    let resolveAuth!: (ok: boolean) => void;
    const authReady = new Promise<boolean>((r) => {
      resolveAuth = r;
    });

    return {
      async onOpen(_e, ws) {
        if (
          !nodeId ||
          !nodeSecret ||
          !(await verifyNodeCredential(nodeId, nodeSecret))
        ) {
          resolveAuth(false);
          ws.close(1008, "unauthorized");
          return;
        }
        authed = nodeId;
        send = (m) => ws.send(JSON.stringify(m));
        connectionManager.register(nodeId, send);
        await setNodeStatus(nodeId, "online");
        resolveAuth(true);

        // Auto-adopt provisioned harness station once the node can answer detect.
        // Fire-and-forget with retries — never blocks or throws into the gateway.
        void (async () => {
          for (const delay of [1500, 4000, 9000]) {
            await new Promise((res) => setTimeout(res, delay));
            try {
              await autoAdoptProvisionedHarness(nodeId);
            } catch {
              // autoAdoptProvisionedHarness never throws, but guard anyway.
            }
          }
        })();

        // Re-read capabilities into already-adopted stations. A node that has
        // just updated may advertise capabilities its stored rows predate, and
        // nothing else in the hub ever refreshes that column — so without this
        // a new capability appears only on stations adopted after the update.
        // Fire-and-forget: it must never block or throw into the gateway.
        void (async () => {
          await new Promise((res) => setTimeout(res, 2000));
          try {
            await refreshAdoptedCapabilities(nodeId);
          } catch {
            // refreshAdoptedCapabilities never throws, but guard anyway.
          }
        })();
      },

      async onMessage(evt, _ws) {
        // Wait for auth to finish rather than dropping early frames (the agent's
        // hello can arrive before verifyNodeCredential resolves).
        if (!authed) {
          const ok = await authReady;
          if (!ok || !authed) return;
        }
        let parsed;
        try {
          parsed = GatewayClientMessage.safeParse(JSON.parse(String(evt.data)));
        } catch {
          return;
        }
        if (!parsed.success) return;
        if (parsed.data.type === "hello") {
          const version = parsed.data.version ?? null;
          await setNodeAgentVersion(authed, version);
        } else if (parsed.data.type === "heartbeat") {
          // A heartbeating socket with no registry entry (swept, or lost to a
          // close race) re-registers itself — server→node send must work for
          // any node that is heartbeating. Never steal an existing entry.
          if (send && !connectionManager.isOnline(authed)) {
            connectionManager.register(authed, send);
          }
          await setNodeStatus(authed, "online");
          connectionManager.send(authed, { type: "ack", ts: Date.now() });
        } else if (parsed.data.type === "health") {
          recordHealth(authed, parsed.data.stations);
        } else if (
          parsed.data.type === "res" ||
          parsed.data.type === "stream"
        ) {
          handleNodeMessage(authed, parsed.data);
        }
      },

      async onClose() {
        resolveAuth(false); // unblock any onMessage awaiting auth on early close
        // Epoch guard: only the currently registered socket tears down. A late
        // close from a replaced socket must not mark the fresh connection
        // offline or drop its send entry.
        if (authed && send && connectionManager.isCurrent(authed, send)) {
          clearNode(authed); // flush health cache immediately on disconnect
          dropNode(authed);
          connectionManager.unregister(authed);
          await setNodeStatus(authed, "offline");
        }
      },
    };
  })
);
