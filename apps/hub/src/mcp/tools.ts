/**
 * The hub's MCP tools.
 *
 * # The rule this file is built around
 *
 * **The principal's kind decides the tool set, once, at registration.** An agent is not offered a
 * tool it must not call. That is deliberately not "register everything and check inside each
 * handler": a check inside a handler is a check one handler out of nine can be written without,
 * and the route audit's whole finding was that ownership checks bolted on beside an id are the
 * thing that gets forgotten.
 *
 * # What an agent gets, and why it is so small
 *
 * Only what lets it see ITSELF. The audit
 * (`docs/superpowers/specs/2026-09-11-route-audit-for-agent-principals.md`) concluded that the
 * fleet reads are reconnaissance for an agent — `fleet-dispatchable` already refuses agent-kind
 * tokens in exactly those terms — and that the write routes change what an agent is.
 *
 * So every agent tool derives its station from the caller's principal and takes **no station
 * id**. There is one id parameter in the whole set, on the transcript, because a transcript is
 * identified by its session; that one checks ownership, and it is the exception the spec names.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import * as acpSessions from "../services/acp-sessions.ts";
import * as broker from "../services/broker.ts";
import { stationForPrincipal, type SelfStation } from "../services/self-station.ts";
import type { McpCaller } from "./auth.ts";

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/**
 * Not an MCP protocol error: a tool that answers "you are not placed in a station" has answered
 * the question. An agent between assignments is an ordinary state, and turning it into a fault
 * makes every caller write error handling for a normal day.
 */
const say = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

export interface ToolDeps {
  caller: McpCaller;
  /** Injected so a test can state a station instead of arranging the world that produces one. */
  station?: (principalId: string) => Promise<SelfStation | null>;
  health?: (nodeId: string, stationKey: string) => Promise<unknown | null>;
}

export function registerHubTools(server: McpServer, deps: ToolDeps): void {
  // The one branch that matters. Everything below it is the agent surface; a human gets none of
  // it, because a human occupies no station and these questions have no answer for them.
  if (deps.caller.kind === "agent") registerAgentTools(server, deps);
}

function registerAgentTools(server: McpServer, deps: ToolDeps): void {
  const { caller } = deps;
  const stationOf = deps.station ?? stationForPrincipal;

  /** Resolve once per call, so an eviction between calls is reflected immediately. */
  const mine = () => stationOf(caller.principalId);

  server.registerTool(
    "agentpod_my_station",
    {
      description:
        "Where you are running: your station key, its node, your harness, your Matrix identity " +
        "and whether the node is online. Takes no arguments — it answers for YOU, and there is " +
        "no way to ask about another station. Returns a plain sentence if you are not currently " +
        "placed in one.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const station = await mine();
      if (!station) return say("You are not currently placed in a station.");

      let health: unknown = null;
      if (deps.health) {
        health = await deps.health(station.nodeId, station.stationKey);
      } else if (station.nodeStatus === "online") {
        // Only asked when the node is up. A broker request to an offline node is a timeout the
        // caller waits out for no information — the node's own status already answered.
        const res = await broker.request(station.nodeId, "health", { key: station.stationKey });
        health = res.ok ? res.data : null;
      }

      return ok({
        station: {
          id: station.id,
          key: station.stationKey,
          harness: station.harness,
          matrixId: station.matrixId,
          identityMode: station.identityMode,
        },
        node: { id: station.nodeId, name: station.nodeName, status: station.nodeStatus },
        health,
      });
    },
  );

  server.registerTool(
    "agentpod_my_sessions",
    {
      description:
        "Your recent ACP sessions on your own station, newest first. Takes no arguments. Use " +
        "this to find the session id of a run you want the transcript of.",
      inputSchema: { limit: z.number().int().positive().max(50).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ limit }) => {
      const station = await mine();
      if (!station) return say("You are not currently placed in a station.");

      // Scoped by the station's OWNER, not by the calling principal. `acp_sessions.user_id`
      // holds a Better Auth id — handing it a `prn_` is the defect that killed every bridge-mode
      // room on 2026-08-31 (#399, #400), and the translation belongs here rather than in the
      // session service.
      const sessions = await acpSessions.listSessions(station.ownerUserId, station.id, {
        limit: limit ?? 10,
      });
      return ok({ station: station.stationKey, sessions });
    },
  );

  server.registerTool(
    "agentpod_my_transcript",
    {
      description:
        "The event transcript of one of YOUR sessions, oldest first. Pass a sessionId from " +
        "agentpod_my_sessions. A session that is not yours is refused.",
      inputSchema: {
        sessionId: z.string().min(1),
        sinceSeq: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ sessionId, sinceSeq }) => {
      const station = await mine();
      if (!station) return say("You are not currently placed in a station.");

      // **The one ownership check in this file**, and the reason it exists: a transcript is
      // identified by its session, so there is an id to tamper with. `readEvents` takes a bare
      // session id and scopes on nothing, so the check has to happen here — and it checks by
      // resolving the session under the station's owner, which fails closed for a session that
      // belongs to somebody else or does not exist.
      const session = await acpSessions.getSession(station.ownerUserId, sessionId);
      if (!session || session.stationId !== station.id) {
        return say("That session is not one of yours.");
      }

      const events = await acpSessions.readEvents(sessionId, sinceSeq ?? 0);
      return ok({ sessionId, count: events.length, events });
    },
  );
}
