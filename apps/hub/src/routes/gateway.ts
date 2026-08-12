/**
 * Node Gateway WebSocket Route
 *
 * Node-agents dial in over WSS using long-term credentials.
 * Endpoint: GET /public/nodes/gateway (WebSocket upgrade)
 *
 * Auth: Authorization: Bearer <nodeId>:<nodeSecret>
 * On open:       register + set online
 * On heartbeat:  refresh online + ack
 * On close:      cancel deferred work + unregister + set offline
 */

import { Hono } from "hono";
import { GatewayClientMessage } from "@agentpod/contract";
import { verifyNodeCredential } from "../services/enrollment";
import { setNodeStatus, setNodeAgentVersion, setNodeCapabilities } from "../services/node-registry";
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

    // Deferred work this connection scheduled, so onClose can cancel it.
    // onOpen fires auto-adopt retries and a capability refresh on timers
    // nothing held a handle to, so a node that connected and hung up a
    // millisecond later still got three adopt attempts and a refresh aimed at
    // it — DB and broker work charged to a socket that was already gone, worst
    // for exactly the crash-looping node that reconnects most often.
    const pending = new Map<ReturnType<typeof setTimeout>, (ok: boolean) => void>();
    let closed = false;

    /**
     * Sleep that this connection can cancel. Resolves true if the delay
     * elapsed with the socket still open, false if onClose cancelled it —
     * callers must bail on false rather than do node work for a dead socket.
     */
    function sleep(ms: number): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(timer);
          resolve(!closed);
        }, ms);
        pending.set(timer, resolve);
      });
    }

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
            // Cancelled by onClose: stop retrying rather than keep adopting
            // for a connection that no longer exists.
            if (!(await sleep(delay))) return;
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
          if (!(await sleep(2000))) return;
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
          // Absent means an older node: store null rather than an empty array,
          // so "did not say" stays distinguishable from "said nothing".
          await setNodeCapabilities(authed, parsed.data.capabilities ?? null);
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

        // Cancel this connection's deferred work. Deliberately NOT behind the
        // epoch guard below: `pending` is this closure's own state, and a
        // replacement socket scheduled its own timers in its own closure, so
        // cancelling here can never starve the fresh connection. Gating it on
        // isCurrent would do the opposite — a replaced socket would fail its
        // own guard and leak its timers, which is precisely the bug.
        closed = true;
        for (const [timer, resolve] of pending) {
          clearTimeout(timer);
          resolve(false); // unblock the awaiting closure so it can return
        }
        pending.clear();

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
