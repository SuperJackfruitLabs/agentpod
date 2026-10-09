import { afterEach, describe, expect, test } from "bun:test";

import { setSuperlibraryClientForTests } from "../services/superlibrary/client";
import { handleMcpRequest } from "./server";

async function toolNames(kind: "agent" | "human"): Promise<string[]> {
  const res = await handleMcpRequest(
    new Request("http://hub.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    { principalId: "prn_000000000000000000a7", kind },
  );
  const raw = await res.text();
  const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? raw;
  const msg = JSON.parse(data);
  if (msg.error) return [];
  return (msg.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
}

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("the link tool is offered only when the hub is configured for Superlibrary", () => {
  test("no client, no tool", async () => {
    restore = setSuperlibraryClientForTests(null);
    expect(await toolNames("agent")).toEqual(["agentpod_my_sessions", "agentpod_my_station", "agentpod_my_transcript"]);
  });

  test("with a client, an agent has it and a person does not", async () => {
    restore = setSuperlibraryClientForTests({} as never);
    expect(await toolNames("agent")).toEqual(["agentpod_link_artifact", "agentpod_my_sessions", "agentpod_my_station", "agentpod_my_transcript"]);
    expect(await toolNames("human")).toEqual([]);
  });
});
