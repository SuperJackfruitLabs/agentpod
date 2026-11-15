import { expect, test } from "bun:test";

import { registerHubTools, type ToolDeps } from "../../src/mcp/tools";
import { gateProseBody, type GatePendingDelivery } from "../../src/services/board-chat/gates";

/**
 * Regression target: returning only the floating item URL, or rendering a gate without the
 * opening run's references, would let a reviewer approve work without seeing its exact version.
 */
test("an artifact link pins its version and the chat gate shows exactly what the run linked", async () => {
  const itemUrl = "https://app.superlibrary.dev/a/itm_0000000000000007";
  const versionUrl = `${itemUrl}/v/7`;
  const configs = new Map<string, any>();
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = {
    registerTool(name: string, config: any, handler: (args: any) => Promise<any>) {
      configs.set(name, config);
      handlers.set(name, handler);
    },
  } as never;
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
  registerHubTools(server, deps);

  const linkResult = JSON.parse(
    (await handlers.get("agentpod_link_artifact")!({ path: "evidence.md" })).content[0].text,
  );
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
  const withReference = gateProseBody({
    ...delivery,
    references: [{ title: "Release evidence", url: versionUrl }],
  } as GatePendingDelivery & { references: Array<{ title: string; url: string }> });
  const withNone = gateProseBody({ ...delivery, references: [] } as GatePendingDelivery & {
    references: Array<{ title: string; url: string }>;
  });

  expect({
    linkResult: {
      url: linkResult.url,
      versionUrl: linkResult.versionUrl,
      next: linkResult.next,
    },
    toolDescription: configs.get("agentpod_link_artifact").description,
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
