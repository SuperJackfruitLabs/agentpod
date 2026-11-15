import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerHubTools, type ToolDeps } from "../../src/mcp/tools";
import { gateProseBody, type GatePendingDelivery } from "../../src/services/board-chat/gates";

type GateReference = { title: string; url: string };

function gateWithReferences(
  delivery: GatePendingDelivery,
  references: GateReference[],
): GatePendingDelivery & { references: GateReference[] } {
  return { ...delivery, references };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function callArtifactTool(deps: ToolDeps): Promise<{
  linkResult: Record<string, unknown>;
  toolDescription: string;
}> {
  const server = new McpServer({ name: "exact-artifact-gate-test", version: "1" });
  registerHubTools(server, deps);
  const client = new Client({ name: "exact-artifact-gate-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    const tool = tools.tools.find(({ name }) => name === "agentpod_link_artifact");
    if (!tool) throw new Error("agentpod_link_artifact was not registered");
    const result = await client.callTool({
      name: "agentpod_link_artifact",
      arguments: { path: "evidence.md" },
    });
    if (!Array.isArray(result.content)) throw new Error("artifact tool returned no content");
    const content = result.content[0];
    if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
      throw new Error("artifact tool returned no text");
    }
    const linkResult: unknown = JSON.parse(content.text);
    if (!isRecord(linkResult)) throw new Error("artifact tool returned a non-object");
    return { linkResult, toolDescription: tool.description ?? "" };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Regression target: returning only the floating item URL, or rendering a gate without the
 * opening run's references, would let a reviewer approve work without seeing its exact version.
 */
test("an artifact link pins its version and the chat gate shows exactly what the run linked", async () => {
  const itemUrl = "https://app.superlibrary.dev/a/itm_0000000000000007";
  const versionUrl = `${itemUrl}/v/7`;
  const linked = {
    ok: true as const,
    itemId: "itm_0000000000000007",
    version: 7,
    url: itemUrl,
    sha256: "fixture",
    mediaType: "text/markdown",
    bytes: 7,
  };
  const deps: ToolDeps = {
    caller: { principalId: "prn_agent", kind: "agent" },
    link: async () => linked,
  };
  const { linkResult, toolDescription } = await callArtifactTool(deps);
  const delivery: GatePendingDelivery = {
    event: "gate.pending",
    boardId: "brd_fixture",
    cardId: "card_fixture",
    gateId: "gate_fixture",
    stageKey: "review",
    returnStageKey: "build",
    cardTitle: "Approve the release evidence",
    producedBy: "agt_fixture",
    options: [
      { id: "approve", label: "Approve" },
      { id: "request_changes", label: "Request changes" },
      { id: "reject", label: "Reject" },
    ],
    ts: "2026-11-16T00:00:00.000Z",
  };
  const withReference = gateProseBody(
    gateWithReferences(delivery, [{ title: "Release evidence", url: versionUrl }]),
  );
  const withNone = gateProseBody(gateWithReferences(delivery, []));

  expect({
    linkResult: {
      url: linkResult.url,
      versionUrl: linkResult.versionUrl,
      next: linkResult.next,
    },
    toolDescription,
    referenceLines: withReference.split("\n").filter((line) => line.includes("Release evidence")),
    noReferenceLines: withNone.split("\n").filter((line) => line.includes("This run linked no artifact")),
  }).toEqual({
    linkResult: {
      url: itemUrl,
      versionUrl,
      next: expect.stringContaining("versionUrl"),
    },
    toolDescription: expect.stringMatching(/attach the (?:returned )?version-pinned URL.*superpipeline_add_reference/i),
    referenceLines: [`- [Release evidence](${versionUrl})`],
    noReferenceLines: ["This run linked no artifact"],
  });
});
