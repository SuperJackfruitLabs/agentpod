/**
 * ACP transport adapter — wraps a broker stream to a node into the WHATWG
 * byte streams the official ACP TypeScript SDK consumes.
 *
 * The SDK's `client(...).connect(stream)` wants a `Stream` of parsed JSON-RPC
 * messages; `ndJsonStream(output, input)` builds one from exactly the pair of
 * Uint8Array streams exposed here:
 *
 *   const wire = await openAcpWire(nodeId, stationKey);
 *   const stream = ndJsonStream(wire.writable, wire.readable);
 *
 * Wire protocol (node-agent acpHandler):
 *   - `acp.open {key}` starts (or reuses) the agent process → `{sessionId}`.
 *   - `acp.attach {sessionId}` streams the agent's stdout as base64 chunks.
 *   - Input frames to the node are keyed by the ACP SESSION id — NOT the
 *     attach stream id (that is the terminal PTY convention).
 *   - The node signals process exit IN-BAND: a dedicated chunk whose decoded
 *     bytes are JSON `{"event":"exit","reason":...}`. That chunk is not
 *     JSON-RPC and must never be forwarded to the SDK.
 */

import { z } from "zod";
import * as broker from "./broker";

const OpenResponseSchema = z.object({ sessionId: z.string().min(1) });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AcpWire {
  /** WHATWG streams carrying raw JSON-RPC bytes, in the shape the SDK's
   *  connection constructor/fluent client() expects. */
  readable: ReadableStream<Uint8Array>; // node → hub (acp.attach chunks, base64-decoded)
  writable: WritableStream<Uint8Array>; // hub → node (sent as input frames keyed by nodeSessionId)
  /** Resolves when the node stream ends; carries the exit reason parsed from
   *  the in-band {"event":"exit","reason":...} frame, or "eof". */
  closed: Promise<string>;
  /** Detach + best-effort acp.close on the node. Idempotent. */
  close(): Promise<void>;
  nodeSessionId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const decoder = new TextDecoder();

/**
 * If the chunk is the node's in-band exit marker, return the exit reason;
 * otherwise null. The node emits the exit frame as its own dedicated chunk
 * after draining output, so any complete chunk that parses as
 * {"event":"exit",...} is the marker (real JSON-RPC never carries "event").
 */
function parseExitReason(bytes: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { event?: unknown }).event === "exit"
    ) {
      const reason = (parsed as { reason?: unknown }).reason;
      return typeof reason === "string" ? reason : String(reason ?? "exit");
    }
  } catch {
    // Not JSON (or a partial/multi-line protocol chunk) — regular bytes.
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open an ACP wire to the station's agent process on a node.
 *
 * Throws Error("Couldn't start the agent process — <broker error>.") when
 * acp.open fails or the node is offline.
 */
export async function openAcpWire(
  nodeId: string,
  stationKey: string
): Promise<AcpWire> {
  const opened = await broker.request(nodeId, "acp.open", { key: stationKey });
  if (!opened.ok) {
    throw new Error(
      `Couldn't start the agent process — ${opened.error ?? "unknown error"}.`
    );
  }
  const parsedOpen = OpenResponseSchema.safeParse(opened.data);
  if (!parsedOpen.success) {
    throw new Error(
      "Couldn't start the agent process — malformed open response."
    );
  }
  const { sessionId } = parsedOpen.data;

  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });

  let controller: ReadableStreamDefaultController<Uint8Array>;
  let writableController: WritableStreamDefaultController;
  let done = false;

  /** Terminate readable, error writable, and settle closed exactly once. */
  const finish = (reason: string) => {
    if (done) return;
    done = true;
    try {
      controller.close();
    } catch {
      // Controller already closed/errored (e.g. consumer cancelled) — fine.
    }
    try {
      // Fail SDK writes fast after the wire ends instead of dropping them.
      writableController.error(new Error(`ACP wire closed (${reason})`));
    } catch {
      // Writable already errored/closed — fine.
    }
    resolveClosed(reason);
  };

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // Consumer tore down the read side (SDK connection closed) — run the
      // same teardown as close() so the agent process is not leaked on the node.
      void close();
    },
  });

  const writable = new WritableStream<Uint8Array>({
    start(c) {
      writableController = c;
    },
    write(bytes) {
      // CRITICAL: input frames are keyed by the ACP SESSION id from acp.open,
      // not the attach stream id. After finish() the stream is errored, so
      // write() is never called on a dead wire.
      broker.sendFrame(nodeId, {
        type: "input",
        id: sessionId,
        data: Buffer.from(bytes).toString("base64"),
      });
    },
  });

  const attach = broker.stream(
    nodeId,
    "acp.attach",
    { sessionId },
    (_seq, chunk, eof) => {
      if (chunk !== null && !done) {
        const bytes = new Uint8Array(Buffer.from(chunk, "base64"));
        const exitReason = parseExitReason(bytes);
        if (exitReason !== null) {
          // In-band exit marker: resolve closed, never forward as protocol bytes.
          finish(exitReason);
          return;
        }
        try {
          controller.enqueue(bytes);
        } catch {
          // Consumer already gone — drop the chunk.
        }
      }
      if (eof) finish("eof");
    }
  );

  let closeStarted = false;
  const close = async (): Promise<void> => {
    if (closeStarted) return;
    closeStarted = true;
    attach.cancel();
    finish("eof");
    // Best-effort: broker.request never rejects; result is ignored.
    void broker.request(nodeId, "acp.close", { sessionId });
  };

  return { readable, writable, closed, close, nodeSessionId: sessionId };
}
