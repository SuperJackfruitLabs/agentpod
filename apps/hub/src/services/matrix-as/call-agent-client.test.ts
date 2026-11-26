import { describe, expect, test } from "bun:test";
import { createSuperdialAgentClient } from "./call-agent-client";

/**
 * C6, the hub's half as a client: join, leave, and a turn's reply, each to superdial-agent with
 * the shared bearer. Room ids are percent-encoded in the path. A failure is reported as `false`,
 * never thrown: a call that could not be joined must not take the appservice transaction with it.
 */

const ROOM = "!r:s";
const ENCODED = "%21r%3As";

function agent(status = 204) {
  const calls: Array<{ url: string; method: string; auth: string | null; type: string | null; body: unknown }> = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers.get("Authorization"),
      type: headers.get("Content-Type"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
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
    expect(await client.reply(ROOM, "8d3b0a52-1c51-4c2b-9b55-2f1e0b4a6f10", body)).toBe(true);
    expect(calls[0]?.url).toBe(`http://agent.test/v1/calls/${ENCODED}/turns/8d3b0a52-1c51-4c2b-9b55-2f1e0b4a6f10/reply`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual(body);
  });

  test("an error answer, or no answer at all, is false and never thrown", async () => {
    expect(await agent(500).client.leaveCall(ROOM)).toBe(false);
    const down = createSuperdialAgentClient({
      baseUrl: "http://agent.test",
      token: "loopback",
      fetch: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(await down.leaveCall(ROOM)).toBe(false);
  });
});
