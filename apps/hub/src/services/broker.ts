/**
 * Broker — request/stream correlation over the gateway WebSocket.
 *
 * Provides two primitives:
 *   request()  — RPC-style: send a req, await a single res (with timeout).
 *   stream()   — streaming: send a req, receive chunks via onChunk, cancel early.
 *
 * Both primitives:
 *   - Generate a UUID correlation id.
 *   - Route outgoing messages through connectionManager.send().
 *   - Are resolved/cancelled via handleNodeMessage(), called from gateway.ts onMessage.
 *
 * Timeout policy: request() resolves (never rejects) with {ok:false, error:"timeout"}
 * after timeoutMs so callers can use a simple await without try/catch.
 */

import type { ResponseMsg, StreamMsg, InputMsg, ResizeMsg } from "@agentpod/contract";
import { connectionManager } from "./connection-manager";

// ─── Types ────────────────────────────────────────────────────────────────────

type RequestResult = { ok: boolean; data?: unknown; error?: string };

type PendingEntry = {
  nodeId: string;
  resolve: (result: RequestResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type StreamHandler = (
  seq: number,
  chunk: string | null,
  eof: boolean
) => void;

type StreamEntry = {
  nodeId: string;
  handler: StreamHandler;
};

// ─── Module-level registries (single-operator; same posture as connection-manager) ─

const pending = new Map<string, PendingEntry>();
const streams = new Map<string, StreamEntry>();

const DEFAULT_TIMEOUT_MS = 15_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a one-shot RPC to the node and await its response.
 *
 * Resolves with {ok:false, error:"node offline"} if the node is not connected.
 * Resolves with {ok:false, error:"timeout"} if no response arrives within timeoutMs.
 * Never rejects — callers can always `await` without try/catch.
 */
/**
 * Called with the node id on every outbound verb, so a substrate that idles its
 * runtimes out can be told the station is in use.
 *
 * A hook rather than a direct call: the broker must not grow a dependency on
 * the runtime tables or on any provisioner. Registered at boot in
 * `provisioner/bootstrap.ts`.
 *
 * Every caller of request()/stream() is a user-initiated route — the hub does no
 * periodic polling of nodes — so this fires on real activity, not on heartbeats.
 */
let activityHook: ((nodeId: string) => void) | null = null;

export function setActivityHook(fn: ((nodeId: string) => void) | null): void {
  activityHook = fn;
}

export function request(
  nodeId: string,
  verb: string,
  params: unknown,
  opts?: { timeoutMs?: number }
): Promise<RequestResult> {
  activityHook?.(nodeId);
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);

    pending.set(id, { nodeId, resolve, timer });

    const sent = connectionManager.send(nodeId, {
      type: "req",
      id,
      verb,
      params,
    });

    if (!sent) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, error: "node offline" });
    }
  });
}

/**
 * Send a streaming RPC to the node; deliver each chunk via onChunk.
 *
 * The handler is dropped automatically on the first message with eof:true.
 * Returns {cancel(), id} — id is the correlation id of the stream request,
 * needed by callers that must forward input/resize frames to the same request.
 */
export function stream(
  nodeId: string,
  verb: string,
  params: unknown,
  onChunk: StreamHandler
): { cancel(): void; id: string } {
  activityHook?.(nodeId);
  const id = crypto.randomUUID();
  let active = true;

  streams.set(id, { nodeId, handler: onChunk });

  const sent = connectionManager.send(nodeId, {
    type: "req",
    id,
    verb,
    params,
  });

  if (!sent) {
    // Node offline — drop the handler and signal eof so the caller is not left hanging.
    streams.delete(id);
    active = false;
    onChunk(0, null, true);
  }

  return {
    id,
    cancel() {
      if (!active) return;
      active = false;
      if (streams.delete(id)) {
        connectionManager.send(nodeId, { type: "cancel", id });
      }
    },
  };
}

/**
 * Send an input, resize, or cancel frame directly to a node (terminal interactivity).
 *
 * Fire-and-forget — no correlation tracking.  Used by the console↔hub terminal
 * bridge to forward keystrokes and resize events to the node PTY session.
 * Returns false if the node is offline.
 */
export function sendFrame(
  nodeId: string,
  frame: InputMsg | ResizeMsg | { type: "cancel"; id: string }
): boolean {
  return connectionManager.send(nodeId, frame);
}

/**
 * Called by gateway.ts onMessage for every res/stream message from a node.
 * Routes to the correct pending request or stream handler.
 */
export function handleNodeMessage(
  _nodeId: string,
  msg: ResponseMsg | StreamMsg
): void {
  if (msg.type === "res") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve({ ok: msg.ok, data: msg.data, error: msg.error });
    return;
  }

  if (msg.type === "stream") {
    const entry = streams.get(msg.id);
    if (!entry) return;
    entry.handler(msg.seq, msg.chunk, msg.eof);
    if (msg.eof) {
      streams.delete(msg.id);
    }
  }
}

/**
 * Called when a node disconnects to purge all in-flight state for that node.
 *
 * - Pending requests: timer is cleared and the promise resolves with {ok:false, error:"node disconnected"}.
 * - Active streams: onChunk is called with eof:true so the caller is not left hanging, then the entry is removed.
 */
export function dropNode(nodeId: string): void {
  for (const [id, entry] of pending) {
    if (entry.nodeId === nodeId) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve({ ok: false, error: "node disconnected" });
    }
  }

  for (const [id, entry] of streams) {
    if (entry.nodeId === nodeId) {
      streams.delete(id);
      entry.handler(0, null, true);
    }
  }
}
