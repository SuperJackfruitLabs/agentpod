/**
 * ACP Session Routes — REST session management + console session WebSocket.
 *
 * REST (mounted at /api in index.ts):
 *   POST /stations/:id/acp/sessions {mode} → 201 AcpSessionRow
 *        (400 invalid mode, 401 anonymous, 403 no acp capability,
 *         404 unknown station, 409 active session exists,
 *         502 node offline / agent open failure)
 *   GET  /stations/:id/acp/sessions → AcpSessionRow[] (newest first)
 *
 * WS: GET /acp/sessions/:sessionId/ws (upgrade)
 *   Mirrors station-terminal.ts for the security preamble: CSWSH origin
 *   check via isAllowedOrigin, auth via c.get("user"), ownership via
 *   getSession(userId, sessionId) — all before any work happens.
 *
 *   Protocol per @agentpod/contract AcpClientMsg / AcpServerMsg:
 *     subscribe {sinceSeq} → {t:"session"} row, replay of acp_events with
 *       seq > sinceSeq in order, {t:"replay-done", lastSeq}, then live
 *       events as they are persisted.
 *     prompt / cancel / permission-answer / set-mode → service calls.
 *   Every inbound message is validated with AcpClientMsg.safeParse; invalid
 *   input and service errors are surfaced as a synthetic `error` EVENT
 *   (seq 0, never persisted) — NOT a WS close.
 *
 *   Client disconnect only unsubscribes. It must NOT end or cancel the
 *   session: sessions are hub-owned and survive tab close (the ONE semantic
 *   difference from the terminal route, which detaches a per-client PTY
 *   stream). {t:"bye"} is sent when the session itself ends.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  AcpClientMsg,
  AcpSessionMode,
  type AcpEvent,
  type AcpEventType,
  type AcpServerMsg,
} from "@agentpod/contract";
import { upgradeWebSocket } from "../ws";
import { db } from "../db/drizzle";
import { acpEvents } from "../db/schema/acp";
import { isAllowedOrigin } from "../config";
import { getStation } from "../services/station-registry";
import * as acp from "../services/acp-sessions";
import type { AuthUser } from "../auth/middleware";

// ─── Error-to-status helper ───────────────────────────────────────────────────

/**
 * Maps createSession error messages to HTTP statuses. The service throws
 * plain Errors with stable, user-facing messages (see acp-sessions.ts);
 * anything unrecognised is an upstream failure (node offline, acp.open
 * failed, agent handshake broke) → 502.
 */
function createErrorStatus(message: string): 403 | 404 | 409 | 502 {
  if (message === "Station not found.") return 404;
  if (message === "This station does not support agent sessions.") return 403;
  if (message === "An active session already exists for this agent.") return 409;
  return 502;
}

// ─── Route schemas ────────────────────────────────────────────────────────────

const CreateBody = z.object({ mode: AcpSessionMode });

// ─── Routes ───────────────────────────────────────────────────────────────────

export const stationAcpRoutes = new Hono()

  /**
   * POST /api/stations/:id/acp/sessions
   *
   * Body: { mode: "ask" | "accept-edits" | "full-auto" }
   * Starts the station's agent process over ACP and returns the session row.
   * Ownership/capability/online checks live in the service (createSession).
   */
  .post(
    "/stations/:id/acp/sessions",
    zValidator("json", CreateBody),
    async (c) => {
      const user = c.get("user") as AuthUser | undefined;
      if (!user || user.id === "anonymous") {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const stationId = c.req.param("id");
      const { mode } = c.req.valid("json");

      try {
        const row = await acp.createSession({ stationId, userId: user.id, mode });
        return c.json(row, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, createErrorStatus(message));
      }
    }
  )

  /**
   * GET /api/stations/:id/acp/sessions
   *
   * Lists the caller's sessions for the station, newest first.
   */
  .get("/stations/:id/acp/sessions", async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const stationId = c.req.param("id");
    const station = await getStation(user.id, stationId);
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    const rows = await acp.listSessions(user.id, stationId);
    // Newest first (createdAt is an ISO string — lexicographic order works).
    rows.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    );
    return c.json(rows);
  })

  /**
   * GET /api/acp/sessions/:sessionId/ws (WebSocket upgrade)
   *
   * Console session socket. See the file header for the protocol.
   */
  .get(
    "/acp/sessions/:sessionId/ws",
    upgradeWebSocket((c) => {
      // Capture context values at upgrade time — c is available here but NOT
      // inside the async callbacks (Hono closes over it for us).
      const user = c.get("user") as AuthUser | undefined;
      const sessionId = c.req.param("sessionId");
      // Capture the Origin header now for CSWSH validation inside onOpen.
      const upgradeOrigin = c.req.header("Origin") ?? null;

      // Mutable state shared across onOpen / onMessage / onClose.
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      /** Highest event seq delivered to this client (replay + live). */
      let lastSent = 0;
      /** Serializes message handling so replay/live ordering is deterministic. */
      let chain: Promise<void> = Promise.resolve();
      /** Resolves true once onOpen's checks passed (messages wait on it). */
      let allowMessages!: (ok: boolean) => void;
      const gate = new Promise<boolean>((resolve) => {
        allowMessages = resolve;
      });

      type Ws = { send(data: string): void; close(code?: number, reason?: string): void };

      const send = (ws: Ws, msg: AcpServerMsg) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          // Client already disconnected.
        }
      };

      /**
       * Surface an error to the client as a synthetic `error` EVENT — never a
       * WS close. seq 0 marks it as outside the transcript (real seqs start
       * at 1) so it can never advance a client's replay cursor.
       */
      const sendError = (ws: Ws, message: string) => {
        send(ws, {
          t: "event",
          event: {
            sessionId,
            seq: 0,
            type: "error",
            payload: { message },
            createdAt: new Date().toISOString(),
          },
        });
      };

      const byeAndClose = (ws: Ws, reason: string) => {
        if (closed) return;
        closed = true;
        send(ws, { t: "bye", reason });
        try {
          ws.close(1000, "session ended");
        } catch {
          // Already closed.
        }
      };

      /** Deliver a LIVE event; a state-ended event also says goodbye. */
      const deliver = (ws: Ws, e: AcpEvent) => {
        if (closed || e.seq <= lastSent) return;
        lastSent = e.seq;
        send(ws, { t: "event", event: e });
        if (e.type === "state") {
          const p = e.payload as { status?: unknown; reason?: unknown };
          if (p?.status === "ended") {
            byeAndClose(
              ws,
              typeof p.reason === "string" ? p.reason : "Session ended."
            );
          }
        }
      };

      const handleSubscribe = async (ws: Ws, sinceSeq: number) => {
        const row = await acp.getSession(user!.id, sessionId);
        // Leak guard (station-terminal "Fix 1" pattern): if the client
        // disconnected while we were awaiting the DB lookup, onClose already
        // ran — with unsubscribe still null, so it had nothing to remove.
        // Registering a subscriber now would leak it forever.
        if (closed) return;
        if (!row) {
          sendError(ws, "Couldn't find that session.");
          return;
        }

        // Re-subscribe replaces the previous subscription with a fresh replay.
        unsubscribe?.();
        unsubscribe = null;
        lastSent = sinceSeq;

        send(ws, { t: "session", session: row });

        // Register the live subscription BEFORE reading the DB so no event can
        // fall in the gap; arrivals during replay buffer and flush after
        // replay-done (deliver() dedupes by seq against the replayed rows).
        let replayDone = false;
        const buffered: AcpEvent[] = [];
        unsubscribe = acp.subscribe(sessionId, (e) => {
          if (closed) return;
          if (!replayDone) {
            buffered.push(e);
            return;
          }
          deliver(ws, e);
        });

        // Leak guard, part two: onClose may have run in the microtask gap
        // around the await above. It could not cancel (unsubscribe was null
        // then), so self-unsubscribe now.
        if (closed) {
          unsubscribe();
          unsubscribe = null;
          return;
        }

        const rows = await db
          .select()
          .from(acpEvents)
          .where(
            and(eq(acpEvents.sessionId, sessionId), gt(acpEvents.seq, sinceSeq))
          )
          .orderBy(asc(acpEvents.seq));

        // Disconnected during the replay read: onClose has already removed
        // the subscription (unsubscribe was set) — just stop.
        if (closed) return;

        // Replay. A state-ended event in the replay defers its bye until
        // after replay-done so the client always sees the full transcript
        // and the replay-done marker first.
        let endedReason: string | null = null;
        for (const r of rows) {
          if (r.seq <= lastSent) continue;
          lastSent = r.seq;
          const payload = r.payload;
          send(ws, {
            t: "event",
            event: {
              sessionId: r.sessionId,
              seq: r.seq,
              type: r.type as AcpEventType,
              payload,
              createdAt: r.createdAt.toISOString(),
            },
          });
          if (r.type === "state") {
            const p = payload as { status?: unknown; reason?: unknown };
            if (p?.status === "ended") {
              endedReason = typeof p.reason === "string" ? p.reason : "Session ended.";
            }
          }
        }

        send(ws, { t: "replay-done", lastSeq: lastSent });
        replayDone = true;
        for (const e of buffered.splice(0)) deliver(ws, e);

        // Ended before this subscriber arrived (possibly before sinceSeq).
        if (endedReason === null && row.status === "ended") {
          endedReason = row.endedReason ?? "Session ended.";
        }
        if (endedReason !== null) byeAndClose(ws, endedReason);
      };

      return {
        async onOpen(_e, ws) {
          // ── 0. CSWSH origin check (same policy as station-terminal) ──────
          if (!isAllowedOrigin(upgradeOrigin)) {
            ws.close(1008, "Forbidden: origin not allowed");
            allowMessages(false);
            return;
          }

          // ── 1. Authenticate ──────────────────────────────────────────────
          if (!user || user.id === "anonymous") {
            ws.close(1008, "Unauthorized");
            allowMessages(false);
            return;
          }

          // ── 2. Ownership: the session must exist AND belong to the user ──
          // A lookup failure must not strand the socket with the gate pending
          // (messages would queue unboundedly) — close it instead.
          let row: Awaited<ReturnType<typeof acp.getSession>>;
          try {
            row = await acp.getSession(user.id, sessionId);
          } catch {
            allowMessages(false);
            ws.close(1011, "Couldn't open the session.");
            return;
          }
          if (!row) {
            ws.close(1008, "session not found");
            allowMessages(false);
            return;
          }

          allowMessages(true);
        },

        onMessage(evt, ws) {
          // Chain so subscribe replay and subsequent actions stay ordered.
          chain = chain.then(async () => {
            if (closed || !(await gate)) return;

            let raw: unknown;
            try {
              raw = JSON.parse(String(evt.data));
            } catch {
              sendError(ws, "Couldn't read that message.");
              return;
            }
            const parsed = AcpClientMsg.safeParse(raw);
            if (!parsed.success) {
              sendError(ws, "Couldn't understand that message.");
              return;
            }

            const msg = parsed.data;
            const userId = user!.id;
            try {
              switch (msg.t) {
                case "subscribe":
                  await handleSubscribe(ws, msg.sinceSeq);
                  break;
                case "prompt":
                  await acp.promptSession(userId, sessionId, msg.text);
                  break;
                case "cancel":
                  await acp.cancelTurn(userId, sessionId);
                  break;
                case "permission-answer":
                  await acp.answerPermission(
                    userId,
                    sessionId,
                    msg.requestSeq,
                    msg.optionId
                  );
                  break;
                case "set-mode":
                  await acp.setMode(userId, sessionId, msg.mode);
                  break;
              }
            } catch (err) {
              sendError(ws, err instanceof Error ? err.message : String(err));
            }
          });
        },

        onClose() {
          // Unsubscribe ONLY. The session is hub-owned: a tab close must not
          // end or cancel it — a later socket re-subscribes and replays.
          closed = true;
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    })
  );
