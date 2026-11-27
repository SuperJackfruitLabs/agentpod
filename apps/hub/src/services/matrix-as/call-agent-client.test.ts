import { describe, expect, test } from "bun:test";
import { createSuperdialAgentClient } from "./call-agent-client";

/**
 * C6, the hub's half as a client: join, leave, and a turn's reply, each to superdial-agent with
 * the shared bearer. Room ids are percent-encoded in the path. A failure is reported as `false`,
 * never thrown: a call that could not be joined must not take the appservice transaction with it.
 */

const ROOM = "!r:s";
/** What a request answered, or "still waiting" a second later. */
const bound = (p: Promise<unknown>) =>
  Promise.race([p, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000))]);
const JOIN = {
  agent_user_id: "@agent_x:s",
  homeserver_url: "http://hs.test",
  device: { device_id: "SUPERDIAL", access_token: "syt_call" },
  voice: "af_heart",
  stt_language: null,
};
const ENCODED = "%21r%3As";

function agent(status = 204) {
  const calls: Array<{ url: string; method: string; auth: string | null; type: string | null; body: unknown }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers.get("Authorization"),
      type: headers.get("Content-Type"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(null, { status });
  };
  return { calls, client: createSuperdialAgentClient({ baseUrl: "http://agent.test", token: "loopback", fetch }) };
}

describe("the superdial-agent client", () => {
  test("joinCall is PUT /v1/calls/{room_id} with the call device and voice", async () => {
    const { calls, client } = agent(202);
    const body = {
      agent_user_id: "@agent_x:s",
      homeserver_url: "http://hs.test",
      device: { device_id: "SUPERDIAL", access_token: "syt_call" },
      voice: "af_heart",
      stt_language: null,
    };
    expect(await client.joinCall(ROOM, body)).toBe(true);
    expect(calls).toEqual([
      { url: `http://agent.test/v1/calls/${ENCODED}`, method: "PUT", auth: "Bearer loopback", type: "application/json", body },
    ]);
  });

  test("leaveCall is DELETE /v1/calls/{room_id}", async () => {
    const { calls, client } = agent(204);
    expect(await client.leaveCall(ROOM)).toBe(true);
    expect(calls).toEqual([
      { url: `http://agent.test/v1/calls/${ENCODED}`, method: "DELETE", auth: "Bearer loopback", type: null, body: undefined },
    ]);
  });

  test("reply is POST /v1/calls/{room_id}/turns/{turn_id}/reply, one final message", async () => {
    const { calls, client } = agent(204);
    const body = { seq: 0, text: "It is ten past four.", final: true, outcome: "ok" } as const;
    expect(await client.reply(ROOM, "8d3b0a52-1c51-4c2b-9b55-2f1e0b4a6f10", body)).toBe("taken");
    expect(calls[0]?.url).toBe(`http://agent.test/v1/calls/${ENCODED}/turns/8d3b0a52-1c51-4c2b-9b55-2f1e0b4a6f10/reply`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual(body);
  });

  test("a reply answered 404 is the call gone: tried once, and said at debug, not as a warning", async () => {
    // superdial-agent forgets a call when its caller hangs up; a reply racing that is not a fault.
    const warns: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warns.push(args);
    const { calls, client } = agent(404);
    try {
      const body = { seq: 0, text: "Too late.", final: true, outcome: "ok" } as const;
      expect(await client.reply(ROOM, "8d3b0a52-1c51-4c2b-9b55-2f1e0b4a6f10", body)).toBe("gone");
    } finally {
      console.warn = original;
    }
    expect(calls).toHaveLength(1);
    expect(warns).toEqual([]);
  });

  test("a reply refused otherwise, or not reachable, failed", async () => {
    const body = { seq: 0, text: "x", final: true, outcome: "ok" } as const;
    expect(await agent(500).client.reply(ROOM, "t", body)).toBe("failed");
    const down = createSuperdialAgentClient({
      baseUrl: "http://agent.test",
      token: "loopback",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    expect(await down.reply(ROOM, "t", body)).toBe("failed");
  });

  test("an error answer, or no answer at all, is false and never thrown", async () => {
    expect(await agent(500).client.leaveCall(ROOM)).toBe(false);
    const down = createSuperdialAgentClient({
      baseUrl: "http://agent.test",
      token: "loopback",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    expect(await down.leaveCall(ROOM)).toBe(false);
  });

  test("a superdial-agent that never answers is given up on within the bound", async () => {
    // Every caller is on a path that must not wait for ever: a turn's end, a call's join.
    const signals: Array<AbortSignal | null | undefined> = [];
    const hung = createSuperdialAgentClient({
      baseUrl: "http://agent.test",
      token: "loopback",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signals.push(init?.signal);
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const body = { seq: 0, text: "x", final: true, outcome: "ok" } as const;
    expect(await bound(hung.joinCall(ROOM, JOIN))).toBe(false);
    expect(await bound(hung.leaveCall(ROOM))).toBe(false);
    expect(await bound(hung.reply(ROOM, "t", body))).toBe("failed");
    expect(signals).toHaveLength(3);
  });

  test("every request carries a timeout by default", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const client = createSuperdialAgentClient({
      baseUrl: "http://agent.test",
      token: "loopback",
      fetch: async (_url, init) => (seen.push(init?.signal), new Response(null, { status: 204 })),
    });
    await client.joinCall(ROOM, JOIN);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});
