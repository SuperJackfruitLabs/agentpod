/**
 * ACP Session Routes — REST session management + console session WebSocket.
 *
 * REST (mounted at /api in index.ts):
 *   POST /stations/:id/acp/sessions {mode} → 201 AcpSessionRow
 *        (400 invalid mode, 401 anonymous, 403 no acp capability,
 *         404 unknown station, 409 the node can't host a second session,
 *         502 node offline / agent open failure)
 *   GET  /stations/:id/acp/sessions → AcpSessionRow[] (newest activity first)
 *   DELETE /acp/sessions/:sessionId → 204 (ends the session; WS clients get
 *        {t:"bye"}); 401 anonymous, 404 absent/foreign
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
  // Raised only when the node can't key processes per session (no instance
  // echo) and one is already live — the exact string the service throws.
  if (message === "An active session already exists for this agent.") return 409;
  return 502;
}

// ─── Route schemas ────────────────────────────────────────────────────────────

const CreateBody = z.object({ mode: AcpSessionMode });

/** Treat `?limit=` / `?before=` with an empty value as absent, not as junk. */
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

/**
 * Paging for the session list. The cursor is the previous page's last row:
 * `before` its lastEventAt, `beforeId` its id — both halves, or rows tied on
 * the timestamp fall out of history entirely (see listSessions).
 *
 * An out-of-RANGE limit is clamped by the service (1000 → 100): asking for too
 * much is not a bug. A limit that isn't a number, a cursor no Date can parse, or
 * half a cursor IS a client bug — 400 it, because silently serving the default
 * page would hide a broken paging loop and look like "history stops here".
 */
const ListQuery = z
  .object({
    limit: z.preprocess(blankToUndefined, z.coerce.number().finite().optional()),
    before: z.preprocess(
      blankToUndefined,
      z.string().datetime({ offset: true }).optional()
    ),
    beforeId: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  })
  .refine((q) => q.beforeId === undefined || q.before !== undefined, {
    message: "beforeId requires before",
    path: ["beforeId"],
  });

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
   * GET /api/stations/:id/acp/sessions?limit=&before=&beforeId=
   *
   * One page of the caller's sessions for the station, newest ACTIVITY first
   * (the service orders in SQL by last_event_at desc, id desc). `before` +
   * `beforeId` are the previous page's last row — keyset paging, so rows
   * arriving meanwhile can't shift the page.
   */
  .get("/stations/:id/acp/sessions", zValidator("query", ListQuery), async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const stationId = c.req.param("id");
    const station = await getStation(user.id, stationId);
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    const { limit, before, beforeId } = c.req.valid("query");
    // Already ordered newest-activity-first and limited in SQL — never re-sort
    // or re-slice here.
    const rows = await acp.listSessions(user.id, stationId, {
      limit,
      before,
      beforeId,
    });
    return c.json(rows);
  })

  /**
   * DELETE /api/acp/sessions/:sessionId
   *
   * Ends a session (hub-owned). Live sessions tear down their OWN agent process
   * on the node — siblings on the same station keep running; attached WS clients
   * receive {t:"bye"} via the service fan-out (the state-ended event). Stale
   * rows are just marked ended.
   *
   * 204 on success (matches the stations/runtimes DELETE precedent);
   * 404 when the session is absent or belongs to another user.
   */
  .delete("/acp/sessions/:sessionId", async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const sessionId = c.req.param("sessionId");
    const row = await acp.getSession(user.id, sessionId);
    if (!row) {
      return c.json({ error: "Not Found" }, 404);
    }

    await acp.endSession(user.id, sessionId, "Ended from the console.");
    return c.body(null, 204);
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
