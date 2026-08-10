/**
 * acp.ts
 *
 * Thin client for the hub's ACP session API.
 *
 * REST (via client.ts `http`):
 *   POST   /api/stations/:id/acp/sessions {mode} → 201 AcpSessionRow
 *   GET    /api/stations/:id/acp/sessions        → AcpSessionRow[]
 *   DELETE /api/acp/sessions/:sessionId          → 204
 *
 * WS (mirrors terminal.ts):
 *   /api/acp/sessions/:sessionId/ws speaking AcpClientMsg / AcpServerMsg
 *   from @agentpod/contract. Inbound frames are validated with
 *   AcpServerMsg.safeParse; frames that fail to parse are dropped silently
 *   (forward compat — a newer hub may add variants).
 */

import { AcpServerMsg as AcpServerMsgSchema } from "@agentpod/contract";
import type { AcpSessionMode } from "@agentpod/contract";
import { http } from "./client";

export type AcpSessionRow = import("@agentpod/contract").AcpSessionRow;
export type AcpServerMsg = import("@agentpod/contract").AcpServerMsg;
export type AcpClientMsg = import("@agentpod/contract").AcpClientMsg;

/** Resolves the hub base URL the same way client.ts does. */
function hubUrl(): string {
  const stored =
    typeof window !== "undefined" ? window.localStorage.getItem("agentpod.apiUrl") : null;
  return stored ?? (import.meta.env?.PUBLIC_HUB_URL as string | undefined) ?? "http://localhost:3001";
}

// ─── REST helpers ─────────────────────────────────────────────────────────────

export const createAcpSession = (stationId: string, mode: AcpSessionMode) =>
  http<AcpSessionRow>(`/api/stations/${stationId}/acp/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });

export const listAcpSessions = (stationId: string) =>
  http<AcpSessionRow[]>(`/api/stations/${stationId}/acp/sessions`);

export const endAcpSession = (sessionId: string) =>
  http<void>(`/api/acp/sessions/${sessionId}`, { method: "DELETE" });

// ─── WebSocket client ─────────────────────────────────────────────────────────

/** Reason the ACP session connection ended, passed to an `onClose` callback. */
export type AcpCloseReason = "error" | "closed";

export interface AcpSocket {
  /**
   * True only while the underlying WebSocket is OPEN (readyState 1).
   *
   * A caller that expects a RESPONSE to its frame must check this: a
   * CONNECTING socket buffers (fine — the queue flushes on open), but a
   * CLOSING/CLOSED one silently swallows the frame forever, and `onClose`
   * doesn't always arrive to say so (a slept laptop can leave a tab holding a
   * socket the browser calls open until the next write actually fails). Treat
   * "not open" as "no socket" and redial.
   */
  readonly isOpen: boolean;
  /** Send a client message to the hub. Buffered if the socket isn't open yet. */
  send(msg: AcpClientMsg): void;
  /** Register a callback that fires for every parsed server message. */
  onMessage(cb: (msg: AcpServerMsg) => void): void;
  /**
   * Register a callback that fires exactly once when the connection ends —
   * unless it ended because the caller itself called `close()`, in which
   * case no callback fires (the caller already knows). Last registration
   * wins. Reasons: "error" (socket error), "closed" (an unprompted clean
   * close, e.g. network drop).
   */
  onClose(cb: (reason: AcpCloseReason) => void): void;
  /** Close the WebSocket connection. Never fires onClose. */
  close(): void;
}

export function createAcpSocket(sessionId: string): AcpSocket {
  const wsUrl = `${hubUrl().replace(/^http/, "ws")}/api/acp/sessions/${sessionId}/ws`;
  const ws = new WebSocket(wsUrl);

  let messageCallback: ((msg: AcpServerMsg) => void) | null = null;
  let closeCallback: ((reason: AcpCloseReason) => void) | null = null;

  /** True once `close()` has been called by the caller — suppresses onClose. */
  let manualClose = false;
  /** True once onClose has fired, so it never fires a second time. */
  let closeFired = false;

  /** Messages queued while the socket is still in CONNECTING state. */
  const sendQueue: string[] = [];

  function emitClose(reason: AcpCloseReason) {
    if (closeFired || manualClose) return;
    closeFired = true;
    closeCallback?.(reason);
  }

  ws.onopen = () => {
    // Flush any messages that were sent before the socket opened
    for (const payload of sendQueue) {
      ws.send(payload);
    }
    sendQueue.length = 0;
  };

  ws.onmessage = (event: MessageEvent) => {
    let raw: unknown;
    try {
      raw = JSON.parse(event.data as string);
    } catch {
      return;
    }
    const parsed = AcpServerMsgSchema.safeParse(raw);
    if (!parsed.success) return;
    messageCallback?.(parsed.data);
  };

  ws.onerror = () => {
    emitClose("error");
  };

  ws.onclose = () => {
    // Any close not already accounted for above (server/network drop) is a
    // "closed" event, unless it was the direct result of us calling close().
    emitClose("closed");
  };

  return {
    // 1 = WebSocket.OPEN; literal so the mock in tests needs no statics.
    get isOpen() {
      return ws.readyState === 1;
    },

    send(msg) {
      const payload = JSON.stringify(msg);
      // 1 = WebSocket.OPEN; use literal so the mock in tests doesn't need the static
      if (ws.readyState === 1) {
        ws.send(payload);
      } else {
        sendQueue.push(payload);
      }
    },

    onMessage(cb) {
      messageCallback = cb;
    },

    onClose(cb) {
      closeCallback = cb;
    },

    close() {
      manualClose = true;
      ws.close();
    },
  };
}
