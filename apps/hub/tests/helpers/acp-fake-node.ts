/**
 * Fake node with scripted ACP agents — shared by the ACP session-service
 * tests (Task 4) and the ACP WS route tests (Task 5).
 *
 * Like the real node-agent it keys agent processes on (station key, instance):
 * each `acp.open` with a fresh instance spawns a new scripted agent with its
 * OWN process session id, attach stream and prompt state, so concurrent hub
 * sessions on one station can be verified to stream independently. With
 * `legacyOpen` it behaves like a pre-slice-4b node instead: one process per
 * station key, the same `sessionId` for every instance, no echo.
 *
 * Speaks the node-gateway wire protocol (req/res, stream, input, cancel) and,
 * behind `acp.open` / `acp.attach`, scripts a minimal ACP agent:
 *
 *   - `initialize`       → {protocolVersion: 1, agentCapabilities: {}}
 *   - `session/new`      → {sessionId: opts.agentSessionId}
 *   - `session/prompt`   → streams a `session/update` agent_message_chunk;
 *                          optionally issues `session/request_permission` and
 *                          awaits the client's outcome before finishing the
 *                          turn with {stopReason: "end_turn"};
 *                          with `hangPrompt` the turn stays open until cancel.
 *   - `session/cancel`   → resolves the in-flight prompt with
 *                          {stopReason: "cancelled"}.
 *
 * `opts` is held by reference: tests may mutate `opts.permission` between
 * prompts (e.g. to flip the toolCall kind for accept-edits coverage).
 */

const encoder = new TextEncoder();

const b64encode = (s: string) => Buffer.from(encoder.encode(s)).toString("base64");

export interface FakePermissionConfig {
  /** ToolKind used in the request_permission toolCall (default "execute"). */
  toolKind?: string;
  options?: Array<{ optionId: string; name: string; kind: string }>;
}

export interface FakeAcpNodeOpts {
  stationKey?: string;
  /** Node-process session id returned by acp.open (default "acp-proc-1"). */
  processSessionId?: string;
  /** ACP protocol session id returned by session/new (default "sess_agent_1"). */
  agentSessionId?: string;
  workspacePath?: string;
  /** When set, session/prompt issues a session/request_permission. Mutable. */
  permission?: FakePermissionConfig | null;
  /** Hold the prompt turn open until session/cancel arrives (or releasePrompt). */
  hangPrompt?: boolean;
  /** Ignore session/cancel: a hanging prompt stays open until releasePrompt(). */
  ignoreCancel?: boolean;
  /** Respond to acp.open with ok:false and this error. */
  failOpen?: string;
  /**
   * Behave like a node from before slice 4b: accept acp.open but answer with
   * only {sessionId} — never echoing the requested instance. That missing echo
   * is exactly how the hub detects an old node and degrades to one session per
   * station. Default (false) is a modern node, which echoes the instance.
   */
  legacyOpen?: boolean;
  /**
   * Never answer the named handshake request (wedged-agent simulation).
   * Mutable — clear it between createSession attempts to let one succeed.
   */
  hangHandshake?: "initialize" | "session/new";
}

/** One scripted agent process, as spawned by an `acp.open`. */
export interface FakeAgentProcess {
  /** Instance requested on the acp.open that spawned it (null: none sent). */
  instance: string | null;
  /** Node-side process session id (what acp.open returned). */
  sessionId: string;
  /** ACP protocol session id this process answers session/new with. */
  agentSessionId: string;
  /** JSON-RPC messages THIS process received from the hub. */
  agentReceived: Array<Record<string, unknown>>;
  /** Permission outcomes THIS process received, in order. */
  permissionOutcomes: unknown[];
}

export interface FakeAcpNode {
  ws: WebSocket;
  opts: FakeAcpNodeOpts;
  /** Raw gateway messages received by the node (JSON strings). */
  nodeMsgs: string[];
  /** Parsed JSON-RPC messages the scripted agents received, all processes. */
  agentReceived: Array<Record<string, unknown>>;
  /** Outcomes the agents received for their permission requests, in order. */
  permissionOutcomes: unknown[];
  /** Scripted agent processes, in the order acp.open spawned them. */
  processes: FakeAgentProcess[];
  /** The process spawned for a given acp.open instance, if any. */
  processFor(instance: string): FakeAgentProcess | undefined;
  /** Complete the OLDEST still-hanging prompt turn with the given stopReason. */
  releasePrompt(stopReason?: string): void;
  close(): void;
}

export function parsedNodeMsgs(raw: string[]): Record<string, unknown>[] {
  return raw
    .map((r) => {
      try {
        return JSON.parse(r) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null);
}

/** Poll condition() every pollMs until truthy, or throw after timeoutMs. Supports async conditions. */
export async function pollUntil<T>(
  condition: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 5000,
  pollMs = 30
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result as T;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs} ms`);
}

export async function connectFakeAcpNode(
  serverPort: number,
  nodeId: string,
  nodeSecret: string,
  opts: FakeAcpNodeOpts = {}
): Promise<FakeAcpNode> {
  const stationKey = opts.stationKey ?? "acp-sess-station";
  const processSessionId = opts.processSessionId ?? "acp-proc-1";
  const agentSessionId = opts.agentSessionId ?? "sess_agent_1";

  const ws = new WebSocket(`ws://localhost:${serverPort}/public/nodes/gateway`, {
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  } as RequestInit & { headers: Record<string, string> });

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("Node WS connection error"));
  });

  const nodeMsgs: string[] = [];
  const agentReceived: Array<Record<string, unknown>> = [];
  const permissionOutcomes: unknown[] = [];

  // ── Agent-side state, one record per spawned process ────────────────────────
  interface Proc extends FakeAgentProcess {
    /** Set by acp.close: a closed process is never reused by a later open. */
    closed: boolean;
    attachId: string | null;
    streamSeq: number;
    inputBuffer: string;
    pendingPrompts: Array<string | number>;
    permCounter: number;
    outQueue: string[];
    pendingAgentRequests: Map<string, (msg: Record<string, unknown>) => void>;
  }

  const processes: Proc[] = [];
  const decoder = new TextDecoder();

  const spawnProcess = (instance: string | null): Proc => {
    const n = processes.length;
    const proc: Proc = {
      instance,
      // The first process keeps the configured ids so single-session tests read
      // exactly as before; later ones are suffixed so they are distinguishable.
      sessionId: n === 0 ? processSessionId : `${processSessionId}-${n + 1}`,
      agentSessionId: n === 0 ? agentSessionId : `${agentSessionId}-${n + 1}`,
      agentReceived: [],
      permissionOutcomes: [],
      closed: false,
      attachId: null,
      streamSeq: 0,
      inputBuffer: "",
      pendingPrompts: [],
      permCounter: 0,
      outQueue: [],
      pendingAgentRequests: new Map(),
    };
    processes.push(proc);
    return proc;
  };

  /** Send one JSON-RPC message from a process to the hub (as a stream chunk). */
  const sendAgent = (proc: Proc, msg: Record<string, unknown>) => {
    const line = JSON.stringify(msg) + "\n";
    if (proc.attachId === null) {
      proc.outQueue.push(line);
      return;
    }
    ws.send(
      JSON.stringify({
        type: "stream",
        id: proc.attachId,
        seq: proc.streamSeq++,
        chunk: b64encode(line),
        eof: false,
        enc: "base64",
      })
    );
  };

  /** Respond to a SPECIFIC prompt request (the turn's own id). */
  const respondTo = (
    proc: Proc,
    id: string | number,
    result: Record<string, unknown>
  ) => {
    const i = proc.pendingPrompts.indexOf(id);
    if (i === -1) return;
    proc.pendingPrompts.splice(i, 1);
    sendAgent(proc, { jsonrpc: "2.0", id, result });
  };

  /** Respond to a process's OLDEST pending prompt (cancel semantics). */
  const respondOldest = (proc: Proc, result: Record<string, unknown>) => {
    const id = proc.pendingPrompts.shift();
    if (id === undefined) return;
    sendAgent(proc, { jsonrpc: "2.0", id, result });
  };

  const runPromptTurn = async (
    proc: Proc,
    msg: { id: string | number; params: { sessionId: string } }
  ) => {
    proc.pendingPrompts.push(msg.id);
    sendAgent(proc, {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: proc.agentSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Working on it" },
        },
      },
    });

    const perm = opts.permission;
    if (perm) {
      const permId = `perm-${proc.sessionId}-${++proc.permCounter}`;
      const options = perm.options ?? [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ];
      const resp = await new Promise<Record<string, unknown>>((resolve) => {
        proc.pendingAgentRequests.set(permId, resolve);
        sendAgent(proc, {
          jsonrpc: "2.0",
          id: permId,
          method: "session/request_permission",
          params: {
            sessionId: proc.agentSessionId,
            toolCall: {
              toolCallId: "tc-1",
              title: "Do the thing",
              kind: perm.toolKind ?? "execute",
            },
            options,
          },
        });
      });
      const result = resp.result as
        | { outcome?: { outcome: string; optionId?: string } }
        | undefined;
      const outcome = result?.outcome;
      proc.permissionOutcomes.push(outcome ?? resp);
      permissionOutcomes.push(outcome ?? resp);
      if (!outcome || outcome.outcome === "cancelled") {
        respondTo(proc, msg.id, { stopReason: "cancelled" });
        return;
      }
      if (
        outcome.outcome === "selected" &&
        String(outcome.optionId).startsWith("reject")
      ) {
        respondTo(proc, msg.id, { stopReason: "end_turn" });
        return;
      }
    }

    if (opts.hangPrompt) return; // held open until session/cancel or releasePrompt

    sendAgent(proc, {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: proc.agentSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done" },
        },
      },
    });
    respondTo(proc, msg.id, { stopReason: "end_turn" });
  };

  const handleAgentMsg = (proc: Proc, msg: Record<string, unknown>) => {
    proc.agentReceived.push(msg);
    agentReceived.push(msg);
    const method = msg.method as string | undefined;
    const id = msg.id as string | number | undefined;

    if (method === "initialize") {
      if (opts.hangHandshake === "initialize") return; // wedged agent
      sendAgent(proc, {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
    } else if (method === "session/new") {
      if (opts.hangHandshake === "session/new") return; // wedged agent
      sendAgent(proc, {
        jsonrpc: "2.0",
        id,
        result: { sessionId: proc.agentSessionId },
      });
    } else if (method === "session/prompt") {
      void runPromptTurn(
        proc,
        msg as { id: string | number; params: { sessionId: string } }
      );
    } else if (method === "session/cancel") {
      if (!opts.ignoreCancel) respondOldest(proc, { stopReason: "cancelled" });
    } else if (method === undefined && id !== undefined) {
      // Response to an agent-initiated request (e.g. request_permission).
      proc.pendingAgentRequests.get(String(id))?.(msg);
      proc.pendingAgentRequests.delete(String(id));
    } else if (id !== undefined) {
      sendAgent(proc, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
    }
  };

  ws.onmessage = (e) => {
    const raw = String(e.data);
    nodeMsgs.push(raw);
    const msg = JSON.parse(raw) as Record<string, unknown>;

    if (msg.type === "input") {
      // Hub → agent bytes, keyed by the PROCESS session id: route to that
      // process, buffer, split into JSON-RPC lines, dispatch.
      const proc = processes.find((p) => p.sessionId === String(msg.id));
      if (!proc) return; // input for an unknown process — drop.
      proc.inputBuffer += decoder.decode(Buffer.from(String(msg.data), "base64"));
      let nl: number;
      while ((nl = proc.inputBuffer.indexOf("\n")) !== -1) {
        const line = proc.inputBuffer.slice(0, nl).trim();
        proc.inputBuffer = proc.inputBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          handleAgentMsg(proc, JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Not JSON — ignore.
        }
      }
      return;
    }

    if (msg.type === "req") {
      const id = msg.id as string;
      switch (msg.verb) {
        case "detect":
          ws.send(
            JSON.stringify({
              type: "res",
              id,
              ok: true,
              data: [
                {
                  key: stationKey,
                  harness: "opencode",
                  kind: "leaf",
                  displayName: "ACP Session Test",
                  parentKey: null,
                  workspacePath: opts.workspacePath ?? "/workspace/acptest",
                  capabilities: ["health", "acp"],
                  adopted: false,
                },
              ],
            })
          );
          break;

        case "acp.open":
          if (opts.failOpen) {
            ws.send(
              JSON.stringify({ type: "res", id, ok: false, error: opts.failOpen })
            );
          } else {
            const params = msg.params as { instance?: string } | undefined;
            const instance = params?.instance ?? null;
            const echo = !opts.legacyOpen && instance !== null;
            // Modern node: (key, instance) → its own process. Legacy node: ONE
            // process per station key, handed back for every instance — the
            // shared-process hazard the hub must refuse to build on.
            const open = processes.filter((p) => !p.closed);
            const proc = opts.legacyOpen
              ? open[0] ?? spawnProcess(instance)
              : open.find((p) => p.instance === instance) ??
                spawnProcess(instance);
            ws.send(
              JSON.stringify({
                type: "res",
                id,
                ok: true,
                data: echo
                  ? { sessionId: proc.sessionId, instance }
                  : { sessionId: proc.sessionId },
              })
            );
          }
          break;

        case "acp.attach": {
          const wanted = (msg.params as { sessionId?: string } | undefined)
            ?.sessionId;
          const proc = processes.find((p) => p.sessionId === String(wanted));
          if (!proc) break;
          proc.attachId = id;
          // Flush agent messages queued before the attach stream existed.
          for (const line of proc.outQueue.splice(0)) {
            ws.send(
              JSON.stringify({
                type: "stream",
                id,
                seq: proc.streamSeq++,
                chunk: b64encode(line),
                eof: false,
                enc: "base64",
              })
            );
          }
          break;
        }

        case "acp.close": {
          const wanted = (msg.params as { sessionId?: string } | undefined)
            ?.sessionId;
          const proc = processes.find((p) => p.sessionId === String(wanted));
          if (proc) {
            proc.closed = true;
            proc.attachId = null;
          }
          ws.send(
            JSON.stringify({ type: "res", id, ok: true, data: { ok: true } })
          );
          break;
        }
      }
    }
  };

  // Allow onOpen → connectionManager.register to settle.
  await new Promise((r) => setTimeout(r, 150));

  return {
    ws,
    opts,
    nodeMsgs,
    agentReceived,
    permissionOutcomes,
    processes,
    processFor: (instance: string) =>
      processes.find((p) => p.instance === instance),
    /** Oldest hanging turn across processes, in process-spawn order. */
    releasePrompt: (stopReason = "end_turn") => {
      const proc = processes.find((p) => p.pendingPrompts.length > 0);
      if (proc) respondOldest(proc, { stopReason });
    },
    close: () => ws.close(),
  };
}
