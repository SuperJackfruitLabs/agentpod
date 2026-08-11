import { describe, expect, test } from "bun:test";
import { client, AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import { buildAcpAgent, type AcpSessionService } from "../../src/services/acp-agent";

/**
 * A stand-in for the session service. The ACP agent's job is protocol mapping;
 * whether a station is reachable is the session service's problem and is
 * covered by its own tests. Injecting it keeps these tests about ACP.
 */
function fakeSessions(overrides: Partial<AcpSessionService> = {}): {
  service: AcpSessionService;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const service: AcpSessionService = {
    async createSession(input) {
      calls.push({ fn: "createSession", ...input });
      return { id: "acps_test" };
    },
    ...overrides,
  };
  return { service, calls };
}

const connect = (service: AcpSessionService) =>
  client().connect(buildAcpAgent({ userId: "usr_1", stationId: "station_1", sessions: service }));

describe("hub ACP agent — initialize", () => {
  test("advertises the loadSession capability", async () => {
    // Doors exists to attach to a station's EXISTING session. An agent that
    // cannot load one hands the editor a blank pane and a fresh conversation,
    // which is not the product. The handler itself lands in slice 2; the
    // capability has to be true from the start or clients never ask.
    const { service } = fakeSessions();
    const res = await connect(service).agent.request(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(res.agentCapabilities?.loadSession).toBe(true);
  });

  test("reports a protocol version the client can negotiate against", async () => {
    const { service } = fakeSessions();
    const res = await connect(service).agent.request(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(res.protocolVersion).toBe(1);
  });
});

describe("hub ACP agent — session/new", () => {
  test("opens a session on the station the proxy was pointed at", async () => {
    const { service, calls } = fakeSessions();
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    const res = await conn.agent.request(AGENT_METHODS.session_new, { cwd: "/tmp", mcpServers: [] });

    expect(res.sessionId).toBe("acps_test");
    expect(calls).toEqual([
      { fn: "createSession", stationId: "station_1", userId: "usr_1", mode: "ask" },
    ]);
  });

  test("defaults to ask mode, so a remote editor cannot silently get full-auto", async () => {
    // The editor is on someone's laptop and the agent is on a machine that may
    // hold credentials. Defaulting to anything but ask would let a client that
    // never mentions permissions run unattended.
    const { service, calls } = fakeSessions();
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await conn.agent.request(AGENT_METHODS.session_new, { cwd: "/tmp", mcpServers: [] });

    expect(calls[0]!.mode).toBe("ask");
  });

  test("surfaces a session-service failure as an ACP error, not a crash", async () => {
    const { service } = fakeSessions({
      async createSession() {
        throw new Error("Station not found.");
      },
    });
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    await expect(conn.agent.request(AGENT_METHODS.session_new, { cwd: "/tmp", mcpServers: [] })).rejects.toThrow("Station not found.");
  });
});

describe("hub ACP agent — session/prompt", () => {
  /** A fake that records call order and lets a test drive the event stream. */
  function promptFake() {
    const order: string[] = [];
    let emit: ((e: { type: string; payload: unknown }) => void) | undefined;
    const service: AcpSessionService = {
      async createSession() {
        return { id: "acps_test" };
      },
      subscribe(_sessionId, fn) {
        order.push("subscribe");
        emit = fn as typeof emit;
        return () => order.push("unsubscribe");
      },
      async promptSession() {
        order.push("prompt");
        // The agent's first update can land before promptSession resolves —
        // that is the whole reason ordering matters here.
        emit?.({ type: "agent-update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
      },
    };
    return { service, order, emitNow: (e: { type: string; payload: unknown }) => emit?.(e) };
  }

  test("subscribes BEFORE prompting, or the first update is lost", async () => {
    // A late subscriber silently drops whatever the agent said first. This is
    // an ordering bug that looks like an occasional missing line, so it is
    // pinned by a test rather than a comment.
    const { service, order } = promptFake();
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await conn.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: "acps_test",
      prompt: [{ type: "text", text: "hello" }],
    });

    expect(order.indexOf("subscribe")).toBeLessThan(order.indexOf("prompt"));
  });

  test("unsubscribes when the turn ends, so a finished turn stops writing", async () => {
    const { service, order } = promptFake();
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await conn.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: "acps_test",
      prompt: [{ type: "text", text: "hello" }],
    });

    expect(order).toContain("unsubscribe");
  });

  test("forwards agent-update events to the client as session/update", async () => {
    const { service } = promptFake();
    const updates: Array<Record<string, unknown>> = [];
    const conn = client()
      // Notification handlers take the same single context object.
      .onNotification(CLIENT_METHODS.session_update, async ({ params }) => {
        updates.push(params as Record<string, unknown>);
      })
      .connect(buildAcpAgent({ userId: "usr_1", stationId: "station_1", sessions: service }));

    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await conn.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: "acps_test",
      prompt: [{ type: "text", text: "hello" }],
    });

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]!.sessionId).toBe("acps_test");
  });

  test("joins multi-block prompts into the text the session service takes", async () => {
    let seen = "";
    const service: AcpSessionService = {
      async createSession() {
        return { id: "acps_test" };
      },
      subscribe() {
        return () => {};
      },
      async promptSession(_u, _s, text) {
        seen = text;
      },
    };
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await conn.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: "acps_test",
      prompt: [
        { type: "text", text: "one " },
        { type: "text", text: "two" },
      ],
    });

    expect(seen).toBe("one two");
  });
});
