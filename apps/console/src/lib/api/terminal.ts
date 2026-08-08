/**
 * terminal.ts
 *
 * Thin WebSocket client for the hub terminal bridge.
 *
 * Protocol (hub ↔ client):
 *   client → hub  {t:"input",  data: base64(bytes)}
 *   client → hub  {t:"resize", cols: number, rows: number}
 *   hub → client  {t:"data",   data: base64(bytes)}
 *   hub → client  {t:"exit"}
 */

/** Resolves the hub base URL the same way client.ts does. */
function hubUrl(): string {
  const stored =
    typeof window !== "undefined" ? window.localStorage.getItem("agentpod.apiUrl") : null;
  return stored ?? (import.meta.env?.PUBLIC_HUB_URL as string | undefined) ?? "http://localhost:3001";
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────

/** Encode a string to base64 using a UTF-8-safe path. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Decode a base64 string to a UTF-8 string. */
function decodeBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// ─── Public interface ─────────────────────────────────────────────────────────

/** Reason the terminal connection ended, passed to an `onClose` callback. */
export type TerminalCloseReason = "exit" | "error" | "closed";

export interface TerminalClient {
  /** Register a callback that fires whenever the server sends data. */
  onData(cb: (text: string) => void): void;
  /**
   * Register a callback that fires exactly once when the connection ends —
   * unless it ended because the caller itself called `close()`, in which
   * case no callback fires (the caller already knows). Last registration
   * wins. Reasons: "exit" (server sent `{t:"exit"}`), "error" (socket
   * error), "closed" (an unprompted clean close, e.g. network drop).
   */
  onClose(cb: (reason: TerminalCloseReason) => void): void;
  /** Send text input to the remote PTY. Buffered if the socket isn't open yet. */
  send(text: string): void;
  /** Notify the remote PTY of a terminal resize. */
  resize(cols: number, rows: number): void;
  /** Close the WebSocket connection. */
  close(): void;
}

export function createTerminalClient(stationId: string): TerminalClient {
  const wsUrl = `${hubUrl().replace(/^http/, "ws")}/api/stations/${stationId}/terminal`;
  const ws = new WebSocket(wsUrl);

  let dataCallback: ((text: string) => void) | null = null;
  let closeCallback: ((reason: TerminalCloseReason) => void) | null = null;

  /** True once `close()` has been called by the caller — suppresses onClose. */
  let manualClose = false;
  /** True once onClose has fired, so it never fires a second time. */
  let closeFired = false;

  /** Messages queued while the socket is still in CONNECTING state. */
  const sendQueue: string[] = [];

  function emitClose(reason: TerminalCloseReason) {
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
    let msg: { t: string; data?: string };
    try {
      msg = JSON.parse(event.data as string) as { t: string; data?: string };
    } catch {
      return;
    }

    if (msg.t === "data" && msg.data !== undefined) {
      const text = decodeBase64(msg.data);
      dataCallback?.(text);
    } else if (msg.t === "exit") {
      emitClose("exit");
      ws.close();
    }
  };

  ws.onerror = () => {
    emitClose("error");
  };

  ws.onclose = () => {
    // Any close not already accounted for above (server/network drop) is a
    // "closed" event, unless it was the direct result of us calling close().
    emitClose("closed");
  };

  function sendRaw(payload: string) {
    // 1 = WebSocket.OPEN; use literal so the mock in tests doesn't need the static
    if (ws.readyState === 1) {
      ws.send(payload);
    } else {
      sendQueue.push(payload);
    }
  }

  return {
    onData(cb) {
      dataCallback = cb;
    },

    onClose(cb) {
      closeCallback = cb;
    },

    send(text) {
      const data = encodeBase64(text);
      sendRaw(JSON.stringify({ t: "input", data }));
    },

    resize(cols, rows) {
      sendRaw(JSON.stringify({ t: "resize", cols, rows }));
    },

    close() {
      manualClose = true;
      ws.close();
    },
  };
}
