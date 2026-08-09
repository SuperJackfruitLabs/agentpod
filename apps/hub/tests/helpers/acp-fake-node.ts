/**
 * Fake node with a scripted ACP agent — shared by the ACP session-service
 * tests (Task 4) and the ACP WS route tests (Task 5).
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
}

export interface FakeAcpNode {
  ws: WebSocket;
  opts: FakeAcpNodeOpts;
  /** Raw gateway messages received by the node (JSON strings). */
  nodeMsgs: string[];
  /** Parsed JSON-RPC messages the scripted agent received from the hub. */
  agentReceived: Array<Record<string, unknown>>;
  /** Outcomes the agent received for its permission requests, in order. */
  permissionOutcomes: unknown[];
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

  // ── Agent-side state ────────────────────────────────────────────────────────
  let attachId: string | null = null;
  let streamSeq = 0;
  let inputBuffer = "";
  const pendingPrompts: Array<string | number> = [];
  let permCounter = 0;
  const outQueue: string[] = [];
  const pendingAgentRequests = new Map<
    string,
    (msg: Record<string, unknown>) => void
  >();
  const decoder = new TextDecoder();

  /** Send one JSON-RPC message from the agent to the hub (as a stream chunk). */
  const sendAgent = (msg: Record<string, unknown>) => {
    const line = JSON.stringify(msg) + "\n";
    if (attachId === null) {
      outQueue.push(line);
      return;
    }
    ws.send(
      JSON.stringify({
        type: "stream",
        id: attachId,
        seq: streamSeq++,
        chunk: b64encode(line),
        eof: false,
        enc: "base64",
      })
    );
  };

  /** Respond to a SPECIFIC prompt request (the turn's own id). */
  const respondTo = (id: string | number, result: Record<string, unknown>) => {
    const i = pendingPrompts.indexOf(id);
    if (i === -1) return;
    pendingPrompts.splice(i, 1);
    sendAgent({ jsonrpc: "2.0", id, result });
  };

  /** Respond to the OLDEST pending prompt (cancel + releasePrompt semantics). */
  const respondOldest = (result: Record<string, unknown>) => {
    const id = pendingPrompts.shift();
    if (id === undefined) return;
    sendAgent({ jsonrpc: "2.0", id, result });
  };

  const runPromptTurn = async (msg: {
    id: string | number;
    params: { sessionId: string };
  }) => {
    pendingPrompts.push(msg.id);
    sendAgent({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: agentSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Working on it" },
        },
      },
    });

    const perm = opts.permission;
    if (perm) {
      const permId = `perm-${++permCounter}`;
      const options = perm.options ?? [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ];
      const resp = await new Promise<Record<string, unknown>>((resolve) => {
        pendingAgentRequests.set(permId, resolve);
        sendAgent({
          jsonrpc: "2.0",
          id: permId,
          method: "session/request_permission",
          params: {
            sessionId: agentSessionId,
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
      permissionOutcomes.push(outcome ?? resp);
      if (!outcome || outcome.outcome === "cancelled") {
        respondTo(msg.id, { stopReason: "cancelled" });
        return;
      }
      if (
        outcome.outcome === "selected" &&
        String(outcome.optionId).startsWith("reject")
      ) {
        respondTo(msg.id, { stopReason: "end_turn" });
        return;
      }
    }

    if (opts.hangPrompt) return; // held open until session/cancel or releasePrompt

    sendAgent({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: agentSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done" },
        },
      },
    });
    respondTo(msg.id, { stopReason: "end_turn" });
  };

  const handleAgentMsg = (msg: Record<string, unknown>) => {
    agentReceived.push(msg);
    const method = msg.method as string | undefined;
    const id = msg.id as string | number | undefined;

    if (method === "initialize") {
      sendAgent({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
    } else if (method === "session/new") {
      sendAgent({ jsonrpc: "2.0", id, result: { sessionId: agentSessionId } });
    } else if (method === "session/prompt") {
      void runPromptTurn(msg as { id: string | number; params: { sessionId: string } });
    } else if (method === "session/cancel") {
      if (!opts.ignoreCancel) respondOldest({ stopReason: "cancelled" });
    } else if (method === undefined && id !== undefined) {
      // Response to an agent-initiated request (e.g. request_permission).
      pendingAgentRequests.get(String(id))?.(msg);
      pendingAgentRequests.delete(String(id));
    } else if (id !== undefined) {
      sendAgent({
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
      // Hub → agent bytes: buffer, split into JSON-RPC lines, dispatch.
      inputBuffer += decoder.decode(
        Buffer.from(String(msg.data), "base64")
      );
      let nl: number;
      while ((nl = inputBuffer.indexOf("\n")) !== -1) {
        const line = inputBuffer.slice(0, nl).trim();
        inputBuffer = inputBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          handleAgentMsg(JSON.parse(line) as Record<string, unknown>);
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
            ws.send(
              JSON.stringify({
                type: "res",
                id,
                ok: true,
                data: { sessionId: processSessionId },
              })
            );
          }
          break;

        case "acp.attach":
          attachId = id;
          // Flush agent messages queued before the attach stream existed.
          for (const line of outQueue.splice(0)) {
            ws.send(
              JSON.stringify({
                type: "stream",
                id,
                seq: streamSeq++,
                chunk: b64encode(line),
                eof: false,
                enc: "base64",
              })
            );
          }
          break;

        case "acp.close":
          ws.send(
            JSON.stringify({ type: "res", id, ok: true, data: { ok: true } })
          );
          break;
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
    releasePrompt: (stopReason = "end_turn") => respondOldest({ stopReason }),
    close: () => ws.close(),
  };
}
