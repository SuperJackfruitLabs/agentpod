/**
 * The hub's MCP server, over Streamable HTTP.
 *
 * Stateless: a fresh `McpServer` per request, tools bound to the authenticated principal. There
 * is no MCP-session state worth keeping — every tool is a thin call into a service the HTTP
 * routes already use, and those services are the authority. kaambaan's server is the model and
 * this follows it deliberately, so the suite has one shape rather than two.
 *
 * **It adds no authority.** Every tool calls a service a route calls, through the same checks. A
 * tool that could do something no route can would be a second authorization model, which is the
 * thing this codebase has spent a month removing rather than adding.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { McpCaller } from "./auth.ts";
import { registerHubTools } from "./tools.ts";

const SERVER_INFO = { name: "agentpod-hub", version: "0.1.0" };

/**
 * Returned in `initialize`, so a client can use the server without prior knowledge.
 *
 * Written for the caller who will actually read it — an agent that has just failed a run and is
 * trying to find out why.
 */
const AGENT_INSTRUCTIONS = `AgentPod is the runtime your work executes on. These tools answer questions about YOURSELF: the station you occupy, and the sessions that ran on it.

  agentpod_my_station     where you are running, and whether the node is healthy
  agentpod_my_sessions    your recent ACP sessions, newest first
  agentpod_my_transcript  the events of one of your sessions

None of them take a station id: they answer for the station you occupy, and there is no way to ask about another. If you are between assignments they will say so plainly — that is not an error.

You will not find the fleet here. Enumerating other agents, nodes or stations is not something an agent token may do, deliberately.

This is the execution side. Your WORK — claiming cards, reporting progress, finishing — lives in kaambaan's MCP server, not this one.`;

const HUMAN_INSTRUCTIONS = `AgentPod's hub. This token names a human principal, and the self-scoped tools (which answer "what station am I running on?") have no meaning for you — a person occupies no station.

Fleet tools are not exposed here yet. Use \`apn fleet\` for nodes, agents, stats and activity.`;

export async function handleMcpRequest(request: Request, caller: McpCaller): Promise<Response> {
  const server = new McpServer(SERVER_INFO, {
    instructions: caller.kind === "agent" ? AGENT_INSTRUCTIONS : HUMAN_INSTRUCTIONS,
  });
  registerHubTools(server, { caller });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
