/**
 * Station Terminal WebSocket Route
 *
 * Bridges a browser WebSocket connection to a node-agent's PTY session.
 * Endpoint: GET /api/stations/:id/terminal (WebSocket upgrade)
 *
 * Auth: Better Auth session cookie, resolved via the authMiddleware that runs
 *       before all /api/* routes and stores the user in c.get("user").
 *       Closes with 1008 if the user is unauthenticated (anonymous).
 *
 * Protocol (hub ↔ client):
 *   Client → hub: { t: "input",  data: string }
 *                 { t: "resize", cols: number, rows: number }
 *   Hub → client: { t: "data",  data: string }   base64 PTY output chunk
 *                 { t: "exit" }                   session ended (eof or error)
 *
 * cols/rows at open: defaults 80×24 are used for term.open.  The client
 * should send a { t: "resize" } message immediately after connecting so the
 * PTY matches the viewport — the node will resize on the next frame.
 *
 * On client disconnect: sends a cancel frame to detach from the stream
 * (DETACH — leaves the PTY session alive on the node).  Does NOT send
 * term.close so reconnecting clients can re-attach.
 *
 * Security: Origin header is validated against the hub's CORS allowed-origins
 * list (see config.ts) to prevent Cross-Site WebSocket Hijacking (CSWSH, #71).
 * WS upgrades are plain GETs so the CSRF middleware does not run for them.
 */

import { Hono } from "hono";
import { upgradeWebSocket } from "../ws";
import * as broker from "../services/broker";
import { getStation } from "../services/station-registry";
import { gateCapability } from "./station-writes";
import { requireGrantReach } from "../services/grant-reach";
import { isGrantReachDenied } from "../services/control-pair";
import { connectionManager } from "../services/connection-manager";
import { recordAudit } from "../services/audit";
import { db } from "../db/drizzle";
import { isAllowedOrigin } from "../config";
import type { AuthUser } from "../auth/middleware";

export const stationTerminalRoutes = new Hono().get(
  "/stations/:id/terminal",
  upgradeWebSocket((c) => {
    // Capture context values at upgrade time — c is available here but NOT
    // inside the async onOpen callbacks (Hono closes over it for us).
    const user = c.get("user") as AuthUser | undefined;
    const stationId = c.req.param("id");
    // Capture the Origin header now for CSWSH validation inside onOpen.
    const upgradeOrigin = c.req.header("Origin") ?? null;

    // Mutable state shared across onOpen / onMessage / onClose.
    let nodeId: string | null = null;
    let attachCancel: (() => void) | null = null;
    let attachId: string | null = null;
    let auditDone:
      | ((result: "ok" | "error", error?: string) => Promise<void>)
      | null = null;
    // Fix 1: closed flag guards against stream leak on early client disconnect.
    // Set in onClose; checked immediately after broker.stream() assigns cancel.
    let closed = false;
    // Fix 2: set true when the node sends eof so onClose does not send a
    // spurious cancel frame for an already-ended stream.
    let streamEnded = false;

    return {
      async onOpen(_e, ws) {
        // ── 0. CSWSH origin check (closes #71) ───────────────────────────
        // WS upgrades are plain GETs — the CSRF middleware does not run for
        // them.  Validate the Origin header against the hub's CORS policy so
        // a malicious page cannot open this shell WS with the victim's cookie.
        // Missing Origin (server-to-server, no browser) is always permitted.
        if (!isAllowedOrigin(upgradeOrigin)) {
          ws.close(1008, "Forbidden: origin not allowed");
          return;
        }

        // ── 1. Authenticate ───────────────────────────────────────────────
        if (!user || user.id === "anonymous") {
          ws.close(1008, "Unauthorized");
          return;
        }

        // ── 2. Resolve station → node ─────────────────────────────────────
        const station = await getStation(user.id, stationId);
        if (!station) {
          ws.send(JSON.stringify({ t: "exit" }));
          ws.close(1011, "station not found");
          return;
        }

        // ── 2b. Capability gate (uniform with the POST mutation routes) ───
        // A terminal is the most powerful mutation (arbitrary shell); enforce
        // the capability server-side, not just by hiding the console tab.
        if (!gateCapability(station, "terminal")) {
          ws.send(JSON.stringify({ t: "exit" }));
          ws.close(1008, "Forbidden: terminal capability");
          return;
        }

        // ── 2c. Reach gate (#345) ─────────────────────────────────────────
        // A shell is the most complete way to change what an agent is, which
        // makes it the clearest case for the second half of the control pair:
        // permission to dispatch an agent is not permission to rewrite it
        // (charter Decision 4). Refused here rather than at the PTY, so no
        // process is ever started.
        try {
          await requireGrantReach(user.id, station, "terminal", "mutate");
        } catch (e) {
          if (!isGrantReachDenied(e)) throw e;
          const denied = await recordAudit(db, {
            userId: user.id,
            nodeId: station.nodeId,
            stationKey: station.stationKey,
            verb: "terminal",
            params: { refused: "grant-reach" },
          });
          await denied.done("error", "refused by the control pair");
          ws.send(JSON.stringify({ t: "exit" }));
          ws.close(1008, "Forbidden: you may not change this agent");
          return;
        }

        // ── 3. Verify node is reachable ───────────────────────────────────
        if (!connectionManager.isOnline(station.nodeId)) {
          ws.send(JSON.stringify({ t: "exit" }));
          ws.close(1011, "node offline");
          return;
        }
        nodeId = station.nodeId;

        // ── 4. Audit (P2 Task 6) ──────────────────────────────────────────
        const audit = await recordAudit(db, {
          userId: user.id,
          nodeId: station.nodeId,
          stationKey: station.stationKey,
          verb: "term.open",
          params: {},
        });
        auditDone = audit.done.bind(audit);

        // ── 5. term.open — open a PTY session on the node ────────────────
        const openResult = await broker.request(station.nodeId, "term.open", {
          key: station.stationKey,
          cols: 80,
          rows: 24,
        });

        if (!openResult.ok) {
          ws.send(JSON.stringify({ t: "exit" }));
          ws.close(1011, openResult.error ?? "term.open failed");
          await auditDone("error", openResult.error).catch(() => {});
          auditDone = null;
          return;
        }

        const { sessionId } = openResult.data as { sessionId: string };

        // ── 6. term.attach — subscribe to PTY output stream ───────────────
        const { cancel, id } = broker.stream(
          station.nodeId,
          "term.attach",
          { sessionId },
          (_seq, chunk, eof) => {
            if (chunk !== null) {
              try {
                ws.send(JSON.stringify({ t: "data", data: chunk }));
              } catch {
                // client already disconnected
              }
            }
            if (eof) {
              // Fix 2: mark stream ended BEFORE closing the WS so that the
              // onClose handler does not send a spurious cancel frame for an
              // already-ended (and already-deleted) stream subscription.
              streamEnded = true;
              try {
                ws.send(JSON.stringify({ t: "exit" }));
                ws.close();
              } catch {
                // already closed
              }
              if (auditDone) {
                auditDone("ok").catch(() => {});
                auditDone = null;
              }
            }
          }
        );

        attachCancel = cancel;
        attachId = id;

        // Fix 1: if the client disconnected while we were awaiting the DB
        // lookup or the term.open RPC, onClose already ran and set closed=true
        // but could not cancel (attachCancel was still null then).  Cancel now.
        if (closed) {
          cancel();
          return;
        }
      },

      onMessage(evt, _ws) {
        if (!nodeId || !attachId) return;

        let msg: unknown;
        try {
          msg = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        const m = msg as Record<string, unknown>;

        if (m.t === "input" && typeof m.data === "string") {
          broker.sendFrame(nodeId, { type: "input", id: attachId, data: m.data });
        } else if (
          m.t === "resize" &&
          typeof m.cols === "number" &&
          typeof m.rows === "number"
        ) {
          broker.sendFrame(nodeId, {
            type: "resize",
            id: attachId,
            cols: m.cols,
            rows: m.rows,
          });
        }
      },

      async onClose() {
        // Fix 1: record that the client is gone so that onOpen, if still
        // running its awaits, can cancel as soon as broker.stream returns.
        closed = true;

        // DETACH: cancel the attach stream so the node stops streaming to this
        // client.  The PTY session remains alive on the node for reconnects.
        // Fix 2: skip if the stream already signalled eof — the subscription
        // has already been removed by the broker and sending cancel would be
        // a no-op at best (the broker guards it) but is semantically wrong.
        if (attachCancel && !streamEnded) {
          attachCancel();
          attachCancel = null;
        }
        // Finalise the audit record if onOpen completed but eof never arrived.
        if (auditDone) {
          await auditDone("ok").catch(() => {});
          auditDone = null;
        }
      },
    };
  })
);
