/**
 * The hub's MCP server, over Streamable HTTP.
 *
 * Stateless: a fresh `McpServer` per request, tools bound to the authenticated principal. There
 * is no MCP-session state worth keeping — every tool is a thin call into a service the HTTP
 * routes already use, and those services are the authority. superpipeline's server is the model and
 * this follows it deliberately, so the suite has one shape rather than two.
 *
 * **It adds no authority.** Every tool calls a service a route calls, through the same checks. A
 * tool that could do something no route can would be a second authorization model, which is the
 * thing this codebase has spent a month removing rather than adding.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { McpCaller } from "./auth.ts";
import * as broker from "../services/broker.ts";
import { stationForPrincipal } from "../services/self-station.ts";
import { superlibraryClient } from "../services/superlibrary/client.ts";
import { linkArtifact } from "../services/superlibrary/link.ts";
import { linkFromOwnStation } from "../services/superlibrary/link-own.ts";
import { stationProvenance } from "../services/superlibrary/provenance.ts";
import { registerHubTools, type ToolDeps } from "./tools.ts";

const SERVER_INFO = { name: "agentpod-hub", version: "0.1.0" };

/**
 * Returned in `initialize`, so a client can use the server without prior knowledge.
 *
 * Written for the caller who will actually read it — an agent that has just failed a run and is
 * trying to find out why.
 */
export const AGENT_INSTRUCTIONS = `AgentPod is the runtime your work executes on. These tools answer questions about YOURSELF: the station you occupy, and the sessions that ran on it.

  agentpod_my_station     where you are running, and whether the node is healthy
  agentpod_my_sessions    your recent ACP sessions, newest first
  agentpod_my_transcript  the events of one of your sessions

None of them take a station id: they answer for the station you occupy, and there is no way to ask about another. If you are between assignments they will say so plainly — that is not an error.

You will not find the fleet here. Enumerating other agents, nodes or stations is not something an agent token may do, deliberately.

This is the execution side. Your WORK — claiming cards, reporting progress, finishing — lives in superpipeline's MCP server, not this one.

Superlibrary is the stack's memory. If you also have Superlibrary's MCP server (library_search), search it before non-trivial work. Link files you produce with agentpod_link_artifact (your own workspace only) and attach the url to your card with superpipeline_add_reference. Never publish through gists, pastebins or personal accounts.`;

const HUMAN_INSTRUCTIONS = `AgentPod's hub. This token names a human principal, and the self-scoped tools (which answer "what station am I running on?") have no meaning for you — a person occupies no station.

Fleet tools are not exposed here yet. Use \`fleet\` for nodes, agents, stats and activity.`;

/** Offered only when the hub is configured for Superlibrary; otherwise the tool does not exist. */
function ownStationLink(): ToolDeps["link"] {
  const client = superlibraryClient();
  if (!client) return undefined;
  return (input) =>
    linkFromOwnStation(
      { stationFor: stationForPrincipal, link: (i) => linkArtifact({ broker, client, provenance: stationProvenance }, i) },
      input,
    );
}

/**
 * SSE keep-alive for a tool call's response stream. Bun.serve closes a connection idle for 10 s
 * (its default `idleTimeout`, which the hub does not change), and the SDK's default keep-alive is
 * 15 s, so a link that reads for longer than 10 s would lose its answer. 5 s stays under it.
 */
export const MCP_SSE_KEEPALIVE_MS = 5_000;

export function newTransport(): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    keepAliveMs: MCP_SSE_KEEPALIVE_MS,
  });
}

/** `opts.link` replaces the configured link, for tests that drive the real handler. */
export async function handleMcpRequest(request: Request, caller: McpCaller, opts: { link?: ToolDeps["link"] } = {}): Promise<Response> {
  const server = new McpServer(SERVER_INFO, {
    instructions: caller.kind === "agent" ? AGENT_INSTRUCTIONS : HUMAN_INSTRUCTIONS,
  });
  registerHubTools(server, { caller, link: opts.link ?? ownStationLink() });

  const transport = newTransport();
  // Stateless: nothing else closes this transport, so a client that hangs up would never abort the
  // tool's `extra.signal`. Closing it on the request's own abort is what makes cancellation real.
  request.signal.addEventListener("abort", () => void transport.close(), { once: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
