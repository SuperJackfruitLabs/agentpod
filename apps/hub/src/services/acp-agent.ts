/**
 * The hub as an ACP agent.
 *
 * Editors do not dial URLs — they spawn a process and speak ACP over its stdio.
 * `apn acp` is that process, and it pipes the bytes here without parsing them.
 * So every protocol decision lives in this file, where the SDK is: initialize,
 * capabilities, session lifecycle, and (later) permission round-trips and
 * version negotiation.
 *
 * Uses the fluent `agent()` API. `AgentSideConnection` is deprecated in SDK
 * 1.3.0 — "@deprecated Prefer agent({ name }).connect(stream)" — and must not
 * gain new call sites.
 *
 * Design: docs/superpowers/specs/2026-08-11-doors-acp-proxy-design.md
 */

import { agent, AGENT_METHODS, RequestError, type AgentApp } from "@agentclientprotocol/sdk";
import type { AcpSessionMode } from "@agentpod/contract";
import * as sessions from "./acp-sessions";

/**
 * The slice of the session service this agent needs.
 *
 * Narrow and injected so the agent's protocol behaviour is testable without a
 * live station: whether a node is reachable is the session service's problem,
 * and it has its own tests for that.
 */
export interface AcpSessionService {
  createSession(input: {
    stationId: string;
    userId: string;
    mode: AcpSessionMode;
  }): Promise<{ id: string }>;
}

export interface AcpAgentOptions {
  userId: string;
  stationId: string;
  /** Defaults to the real session service. */
  sessions?: AcpSessionService;
}

/**
 * The ACP protocol version this agent speaks.
 *
 * Pinned to v1 deliberately. The SDK ships `agentProtocolRouter()` with
 * `.withV1()` / `.withV2()`, but v2 is a draft and the router is marked
 * `@experimental` — shipping our distribution story on someone else's
 * unreleased draft is not a trade worth making. When v2 stabilises this becomes
 * a registration rather than a rewrite.
 */
const PROTOCOL_VERSION = 1;

export function buildAcpAgent(opts: AcpAgentOptions): AgentApp {
  const service: AcpSessionService = opts.sessions ?? sessions;

  return agent({ name: "agentpod" })
    .onRequest(AGENT_METHODS.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // Attaching to a station's existing session is the whole point of
        // Doors. Without this an editor can only ever start a fresh
        // conversation, and `session/load` — which the protocol says must
        // stream the entire history back as notifications — is never offered.
        loadSession: true,
      },
    }))
    .onRequest(AGENT_METHODS.session_new, async () => {
      // `ask` is not a placeholder. The editor is on a laptop and the agent is
      // on a machine that may hold credentials; a client that never mentions
      // permissions must not get an agent running unattended.
      const row = await asAcpError(() =>
        service.createSession({
          stationId: opts.stationId,
          userId: opts.userId,
          mode: "ask",
        }),
      );
      return { sessionId: row.id };
    });
}

/** JSON-RPC internal error. */
const INTERNAL_ERROR = -32603;

/**
 * Preserves the session service's message on the way to the editor.
 *
 * The SDK converts a thrown `Error` into a generic JSON-RPC `"Internal error"`,
 * which is the right default for an unexpected crash and wrong here: the
 * session service throws *deliberately human-readable* messages — "Station not
 * found.", "This station does not support agent sessions.", "An active session
 * already exists for this agent." — that the console already surfaces verbatim.
 * Swallowing them would leave a Zed user staring at "Internal error" with no
 * idea their station is offline.
 *
 * `RequestError` is the SDK's own type and passes through intact.
 */
async function asAcpError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RequestError) throw err;
    throw new RequestError(INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}
