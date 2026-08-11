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

import {
  agent,
  AGENT_METHODS,
  CLIENT_METHODS,
  RequestError,
  type AgentApp,
} from "@agentclientprotocol/sdk";
import type { AcpSessionMode } from "@agentpod/contract";
import * as sessions from "./acp-sessions";
import { createLogger } from "../utils/logger";

const log = createLogger("acp-agent");

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

  promptSession(userId: string, sessionId: string, text: string): Promise<void>;

  /** Returns an unsubscribe function. The hub fans out to N subscribers. */
  subscribe(
    sessionId: string,
    fn: (e: { type: string; seq: number; payload: unknown }) => void,
  ): () => void;

  /** Throws "No pending permission request." when another client answered first. */
  answerPermission(
    userId: string,
    sessionId: string,
    requestSeq: number,
    optionId: string,
  ): Promise<void>;

  cancelTurn(userId: string, sessionId: string): Promise<void>;

  setMode(userId: string, sessionId: string, mode: AcpSessionMode): Promise<void>;

  /** The stored transcript, ordered by seq. Replay is the caller's job. */
  readEvents(
    sessionId: string,
    sinceSeq: number,
  ): Promise<Array<{ seq: number; type: string; payload: unknown }>>;
}

/**
 * ACP's `modeId` is a free-form string; ours is a fixed enum.
 *
 * An unrecognised mode is refused rather than ignored. Silently accepting one
 * would leave the editor believing it had loosened permissions when nothing
 * changed — the most dangerous direction for that mistake to point.
 */
const MODES: readonly AcpSessionMode[] = ["ask", "accept-edits", "full-auto"];

function toSessionMode(modeId: unknown): AcpSessionMode {
  if (typeof modeId === "string" && (MODES as readonly string[]).includes(modeId)) {
    return modeId as AcpSessionMode;
  }
  throw new RequestError(
    INVALID_PARAMS,
    `Unknown mode ${JSON.stringify(modeId)}. Supported: ${MODES.join(", ")}.`,
  );
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
    })
    // Handlers take ONE context object — `{ params, client }` — not
    // (params, ctx). That is what the SDK's deprecation note means by "registers
    // typed handlers with a single context object".
    .onRequest(AGENT_METHODS.session_prompt, async ({ params, client }) => {
      // Subscribe BEFORE prompting. The agent can emit its first update before
      // promptSession resolves, and a late subscriber drops it silently — a bug
      // that shows up as an occasional missing first line rather than a crash.
      // Permission prompts we have put to the editor and are still awaiting.
      // Keyed by the request's event seq, which is what answerPermission takes.
      const outstanding = new Map<number, AbortController>();

      const unsubscribe = service.subscribe(params.sessionId, (event) => {
        switch (event.type) {
          case "agent-update":
            // The only type carrying a raw ACP sessionUpdate payload.
            void client.notify(CLIENT_METHODS.session_update, {
              sessionId: params.sessionId,
              update: event.payload,
            } as never);
            return;

          case "permission-request":
            void askEditor(event);
            return;

          case "permission-answer": {
            // Someone answered — possibly the console, possibly us. Either way
            // this prompt is settled, so stop asking the editor about it.
            const seq = (event.payload as { requestSeq?: number })?.requestSeq;
            if (typeof seq === "number") {
              outstanding.get(seq)?.abort();
              outstanding.delete(seq);
            }
            return;
          }

          default:
            // state and error are the hub's own vocabulary, not ACP frames.
            return;
        }
      });

      /**
       * Put a permission to the editor and apply whatever it says.
       *
       * Both clients are asked and the first answer wins — the honest
       * expression of two live clients on one session. The loser's call finds
       * nothing pending, which is the expected path rather than an error.
       */
      async function askEditor(event: { seq: number; payload: unknown }): Promise<void> {
        const payload = event.payload as {
          toolCall?: unknown;
          options?: unknown[];
          auto?: boolean;
        };

        // accept-edits and full-auto resolve server-side and persist the
        // request with auto:true. Prompting for something already decided is a
        // phantom dialog the editor can never usefully answer.
        if (payload?.auto) return;

        const ac = new AbortController();
        outstanding.set(event.seq, ac);

        try {
          const res = (await client.request(
            CLIENT_METHODS.session_request_permission,
            {
              sessionId: params.sessionId,
              toolCall: payload?.toolCall,
              options: payload?.options,
            } as never,
            // Cooperative: aborting sends $/cancel_request, but whether the
            // editor dismisses its dialog is the editor's call.
            { cancellationSignal: ac.signal },
          )) as { outcome?: { outcome?: string; optionId?: string } };

          const optionId = res?.outcome?.optionId;
          if (!optionId) return; // cancelled, or the editor declined to choose

          await service.answerPermission(opts.userId, params.sessionId, event.seq, optionId);
        } catch (err) {
          // Exactly two losses are expected, and neither is worth crashing a
          // turn over: another client answered first ("No pending permission
          // request."), or our own outstanding request was cancelled because it
          // did. ANYTHING else is a real failure and must be visible.
          //
          // This was a blanket `catch {}` first, and it silently ate an
          // "Invalid params" from the SDK — the editor was never asked and
          // nothing said so. A permission that vanishes is precisely the bug
          // you cannot afford to hide.
          const msg = err instanceof Error ? err.message : String(err);
          const expected =
            msg.includes("No pending permission request") ||
            msg.toLowerCase().includes("cancel");
          if (!expected) {
            log.error("failed to put a permission to the editor", {
              sessionId: params.sessionId,
              requestSeq: event.seq,
              error: msg,
            });
          }
        } finally {
          outstanding.delete(event.seq);
        }
      }

      try {
        await asAcpError(() =>
          service.promptSession(opts.userId, params.sessionId, textOf(params.prompt)),
        );
        return { stopReason: "end_turn" };
      } finally {
        // The turn is over; stop writing to a client that is no longer waiting.
        unsubscribe();
      }
    })
    // A NOTIFICATION, not a request. ACP models cancellation as fire-and-forget,
    // so an editor's stop button never waits for an ack — registering this as a
    // request would make it hang.
    .onNotification(AGENT_METHODS.session_cancel, async ({ params }) => {
      try {
        await service.cancelTurn(opts.userId, params.sessionId);
      } catch (err) {
        // Nothing to reply to; a cancel that arrives after the turn already
        // ended is normal, not an error worth surfacing.
        log.debug("cancel failed", {
          sessionId: params.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
    /**
     * Attach to an existing session and stream its history back.
     *
     * The protocol is explicit that the AGENT replays, not the client: on load
     * it must "restore the session context and conversation history" and
     * "stream the entire conversation history back to the client via
     * notifications". `apn acp` is the agent as far as the editor is concerned,
     * so that work lands here.
     *
     * This is what makes Doors worth having. Without it an editor can only ever
     * start a fresh conversation, and attaching to the station you have worked
     * on all afternoon shows a blank pane.
     *
     * NOTE: session/load is REMOVED in ACP v2, where session/resume explicitly
     * does NOT replay. "Join and see what happened" is a v1 affordance with no
     * settled v2 equivalent — another reason the versions get separate surfaces
     * rather than a field map.
     */
    .onRequest(AGENT_METHODS.session_load, async ({ params, client }) => {
      const events = await asAcpError(() => service.readEvents(params.sessionId, 0));

      for (const event of events) {
        // Same filter as the live path: only agent-update carries a raw ACP
        // sessionUpdate. Replaying the hub's own vocabulary would hand the
        // editor frames it cannot parse, and replaying a permission-request
        // would re-prompt for something already answered.
        if (event.type !== "agent-update") continue;
        await client.notify(CLIENT_METHODS.session_update, {
          sessionId: params.sessionId,
          update: event.payload,
        } as never);
      }

      return {};
    })
    // NOTE: session/set_mode is REMOVED in ACP v2, replaced by config options.
    // Implemented here for v1; when the version router lands, this handler stays
    // on the v1 surface rather than being carried forward.
    .onRequest(AGENT_METHODS.session_set_mode, async ({ params }) => {
      const mode = toSessionMode((params as { modeId?: unknown }).modeId);
      await asAcpError(() => service.setMode(opts.userId, params.sessionId, mode));
      return {};
    });
}

/**
 * ACP prompts are an array of content blocks; the session service takes text.
 *
 * Non-text blocks (images, resources) are dropped rather than stringified —
 * pushing `[object Object]` at a harness is worse than sending less.
 */
function textOf(blocks: ReadonlyArray<{ type: string; text?: string }>): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** JSON-RPC internal error. */
const INTERNAL_ERROR = -32603;
/** JSON-RPC invalid params. */
const INVALID_PARAMS = -32602;

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
