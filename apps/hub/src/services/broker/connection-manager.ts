import type { GatewayServerMessage } from "@agentpod/contract";

export type Send = (msg: GatewayServerMessage) => void;

/** Closes the node's socket from the hub's side. */
export type Close = (code: number, reason: string) => void;

/** Called (synchronously, exceptions swallowed) when a node registers. */
export type NodeOnlineHook = (nodeId: string) => void;

export interface NodeConnectionManager {
  /** `close` lets the hub end the session itself (`disconnect`); optional for test sinks. */
  register(nodeId: string, send: Send, close?: Close): void;
  unregister(nodeId: string): void;
  isOnline(nodeId: string): boolean;
  onlineNodeIds(): string[];
  send(nodeId: string, msg: GatewayServerMessage): boolean;
  /** True when `send` is the currently registered sender for nodeId (epoch guard). */
  isCurrent(nodeId: string, send: Send): boolean;
  /**
   * Close the node's current socket and forget it. False when it has no
   * session. The socket's own onClose still runs, but its epoch guard no longer
   * matches, so it does no teardown of its own.
   */
  disconnect(nodeId: string, code: number, reason: string): boolean;
  /** Register a hook invoked every time a node (re)connects. */
  onNodeOnline(hook: NodeOnlineHook): void;
}

export class InMemoryConnectionManager implements NodeConnectionManager {
  private conns = new Map<string, Send>();
  private closers = new Map<string, Close>();
  private onlineHooks: NodeOnlineHook[] = [];

  register(nodeId: string, send: Send, close?: Close) {
    this.conns.set(nodeId, send);
    if (close) this.closers.set(nodeId, close);
    else this.closers.delete(nodeId);
    for (const hook of this.onlineHooks) {
      try {
        hook(nodeId);
      } catch {
        // Hooks must never break node registration.
      }
    }
  }

  onNodeOnline(hook: NodeOnlineHook) {
    this.onlineHooks.push(hook);
  }

  unregister(nodeId: string) {
    this.conns.delete(nodeId);
    this.closers.delete(nodeId);
  }

  disconnect(nodeId: string, code: number, reason: string) {
    if (!this.conns.has(nodeId)) return false;
    const close = this.closers.get(nodeId);
    this.unregister(nodeId);
    try {
      close?.(code, reason);
    } catch {
      // A socket that is already closing is the outcome we wanted.
    }
    return true;
  }

  isOnline(nodeId: string) {
    return this.conns.has(nodeId);
  }

  onlineNodeIds() {
    return [...this.conns.keys()];
  }

  send(nodeId: string, msg: GatewayServerMessage) {
    const s = this.conns.get(nodeId);
    if (!s) return false;
    s(msg);
    return true;
  }

  isCurrent(nodeId: string, send: Send) {
    return this.conns.get(nodeId) === send;
  }
}

// Swap target later (Redis pub/sub or Durable Object) without touching callers.
export const connectionManager: NodeConnectionManager = new InMemoryConnectionManager();
