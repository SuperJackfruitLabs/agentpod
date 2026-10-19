/** MCP upstream fixtures. Real HTTP/plane verification, synthetic product data and effects. */
import { verifyPlaneBearer } from "../../src/auth/hub-token";

import { SALAAM_MCP_FIXTURE_TOOLS } from "./salaam-mcp-tools";

export function salaamMcpFixture(principal: string) {
  const observed = {
    calls: [] as { server: string; tool: string; principal: string }[],
    metadata: 0,
    aborted: 0,
  };
  const mode = { hold: false, drift: false, principal };
  const handle = async (
    request: Request,
    server: keyof typeof SALAAM_MCP_FIXTURE_TOOLS,
  ): Promise<Response> => {
    const token = (request.headers.get("authorization") ?? "").replace(
      /^Bearer /,
      "",
    );
    const verified = await verifyPlaneBearer(token);
    if (
      !verified.ok ||
      verified.caller.sub !== mode.principal ||
      verified.caller.principalKind !== "agent" ||
      request.headers.has("x-agentpod-proxy-key")
    )
      return Response.json(
        { error: "fixture authority refused" },
        { status: 403 },
      );
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const rpc = (await request.json()) as {
      id?: number;
      method: string;
      params?: { name: string; arguments?: unknown };
    };
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    if (rpc.method === "initialize")
      return reply({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "offline-" + server, version: "1" },
      });
    if (rpc.method === "tools/list") {
      observed.metadata++;
      return reply({
        tools: mode.drift
          ? [
              ...SALAAM_MCP_FIXTURE_TOOLS[server],
              { name: "unreviewed", inputSchema: { type: "object" } },
            ]
          : SALAAM_MCP_FIXTURE_TOOLS[server],
      });
    }
    if (rpc.method === "tools/call") {
      const tool = rpc.params?.name;
      if (!SALAAM_MCP_FIXTURE_TOOLS[server].some((t) => t.name === tool))
        return reply({
          isError: true,
          content: [{ type: "text", text: "Fixture tool not found" }],
        });
      observed.calls.push({
        server,
        tool: tool!,
        principal: verified.caller.sub,
      });
      if (mode.hold)
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(": accepted; result withheld\n\n"),
              );
            },
            cancel() {
              observed.aborted++;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return reply({
        content: [
          {
            type: "text",
            text: `Synthetic scoped memory ${observed.calls.length}`,
          },
        ],
      });
    }
    return new Response(null, { status: 202 });
  };
  return { observed, mode, handle };
}
