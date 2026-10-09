import { afterEach, describe, expect, test } from "bun:test";

import { setSuperlibraryClientForTests } from "../services/superlibrary/client";
import { handleMcpRequest, MCP_SSE_KEEPALIVE_MS, newTransport } from "./server";

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

test("a tool call's SSE stream keeps alive more often than Bun closes an idle connection (10 s)", () => {
  expect(MCP_SSE_KEEPALIVE_MS).toBeLessThan(10_000);
  // The SDK's own field: if the option is dropped, it falls back to its 15 s default.
  expect((newTransport() as unknown as { _keepAliveMs: number })._keepAliveMs).toBe(MCP_SSE_KEEPALIVE_MS);
});

test("a client that hangs up aborts the link it started (the stateless transport is closed on the request's abort)", async () => {
  const ctl = new AbortController();
  let linkSignal: AbortSignal | undefined;
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const aborted = new Promise<void>((resolve) => {
    void handleMcpRequest(
      new Request("http://hub.test/mcp", {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agentpod_link_artifact", arguments: { path: "a.md" } } }),
      }),
      { principalId: "prn_000000000000000000a7", kind: "agent" },
      {
        link: (i) => {
          linkSignal = i.signal;
          started();
          return new Promise((done) => {
            i.signal?.addEventListener("abort", () => { resolve(); done({ ok: false, status: 503, error: "cancelled", message: "x" }); }, { once: true });
          });
        },
      },
    ).then((res) => res.text().catch(() => ""));
  });
  await running;
  expect(linkSignal?.aborted).toBe(false);
  ctl.abort();
  await Promise.race([aborted, new Promise((_, no) => setTimeout(() => no(new Error("the link's signal never aborted")), 2_000))]);
  expect(linkSignal?.aborted).toBe(true);
});
