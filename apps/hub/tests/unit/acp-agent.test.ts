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

describe("hub ACP agent — permissions", () => {
  /** Drives a session and lets a test push events at the agent. */
  function permFake(over: Partial<AcpSessionService> = {}) {
    const calls: Array<Record<string, unknown>> = [];
    let emit: ((e: { type: string; seq: number; payload: unknown }) => void) | undefined;
    let pending: Array<{ type: string; seq: number; payload: unknown }> | undefined;
    const service = {
      async createSession() {
        return { id: "acps_test" };
      },
      subscribe(_s: string, fn: unknown) {
        emit = fn as typeof emit;
        return () => {};
      },
      async promptSession() {
        // Permissions arrive DURING a turn — the agent subscribes for the
        // duration of session/prompt and unsubscribes when it ends. Raising it
        // from here is what a harness actually does.
        pending?.forEach((e) => emit?.(e));
        await Bun.sleep(40); // hold the turn open while the editor answers
      },
      async answerPermission(_u: string, _s: string, requestSeq: number, optionId: string) {
        calls.push({ fn: "answerPermission", requestSeq, optionId });
      },
      ...over,
    } as unknown as AcpSessionService;
    return {
      service,
      calls,
      // Queue an event to be raised from inside the next turn.
      raiseDuringTurn: (e: { type: string; seq: number; payload: unknown }) => {
        pending = [...(pending ?? []), e];
      },
    };
  }

  // Must satisfy the ACP schema — the SDK validates OUTGOING params too.
  // PermissionOption requires {optionId, name, kind}; ToolCallUpdate requires
  // toolCallId. Real payloads come from the harness's own request and do.
  const OPTIONS = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
  const TOOL_CALL = { toolCallId: "tc_1", title: "Write hello.txt" };

  async function connectAsking(
    service: AcpSessionService,
    onAsk: (params: Record<string, unknown>) => Promise<{ outcome: unknown }>,
  ) {
    const conn = client()
      .onRequest(CLIENT_METHODS.session_request_permission, async ({ params }) => {
        return onAsk(params as Record<string, unknown>);
      })
      .connect(buildAcpAgent({ userId: "usr_1", stationId: "station_1", sessions: service }));
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });
    return conn;
  }

  test("a permission request reaches the editor", async () => {
    // With an editor attached, the hub is the ACP agent — so a permission the
    // harness raises must travel OUT to the editor, the reverse of the console
    // flow where the hub parks it and waits.
    const { service, raiseDuringTurn } = permFake();
    let asked: Record<string, unknown> | undefined;
    const conn = await connectAsking(service, async (params) => {
      asked = params;
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });

    raiseDuringTurn({ type: "permission-request", seq: 7, payload: { toolCall: TOOL_CALL, options: OPTIONS } });
    await conn.agent.request(AGENT_METHODS.session_prompt, { sessionId: "acps_test", prompt: [{ type: "text", text: "go" }] });

    expect(asked).toBeDefined();
    expect((asked!.options as unknown[])).toHaveLength(2);
  });

  test("the editor's answer is applied to the session", async () => {
    const { service, calls, raiseDuringTurn } = permFake();
    const conn = await connectAsking(service, async () => ({ outcome: { outcome: "selected", optionId: "reject" } }));

    raiseDuringTurn({ type: "permission-request", seq: 7, payload: { toolCall: TOOL_CALL, options: OPTIONS } });
    await conn.agent.request(AGENT_METHODS.session_prompt, { sessionId: "acps_test", prompt: [{ type: "text", text: "go" }] });

    expect(calls).toContainEqual({ fn: "answerPermission", requestSeq: 7, optionId: "reject" });
  });

  test("an auto-answered permission is never forwarded", async () => {
    // accept-edits and full-auto resolve server-side and persist the request
    // with auto:true. Prompting the editor for something already decided would
    // be a phantom dialog it can never usefully answer.
    const { service, raiseDuringTurn } = permFake();
    let asked = false;
    const conn = await connectAsking(service, async () => {
      asked = true;
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });

    raiseDuringTurn({ type: "permission-request", seq: 7, payload: { toolCall: TOOL_CALL, options: OPTIONS, auto: true } });
    await conn.agent.request(AGENT_METHODS.session_prompt, { sessionId: "acps_test", prompt: [{ type: "text", text: "go" }] });

    expect(asked).toBe(false);
  });

  test("losing the race to the console is swallowed, not thrown", async () => {
    // Both clients are asked and the first answer wins. The loser's call finds
    // nothing pending — that is the expected path, not an error worth crashing
    // a turn over.
    const { service, raiseDuringTurn } = permFake({
      async answerPermission() {
        throw new Error("No pending permission request.");
      },
    });
    const conn = await connectAsking(service, async () => ({ outcome: { outcome: "selected", optionId: "allow" } }));

    raiseDuringTurn({ type: "permission-request", seq: 7, payload: { toolCall: TOOL_CALL, options: OPTIONS } });
    await conn.agent.request(AGENT_METHODS.session_prompt, { sessionId: "acps_test", prompt: [{ type: "text", text: "go" }] });
    // Surviving without an unhandled rejection is the assertion.
    expect(true).toBe(true);
  });
});

describe("hub ACP agent — cancel and mode", () => {
  function verbFake() {
    const calls: Array<Record<string, unknown>> = [];
    const service = {
      async createSession() {
        return { id: "acps_test" };
      },
      subscribe() {
        return () => {};
      },
      async promptSession() {},
      async answerPermission() {},
      async cancelTurn(userId: string, sessionId: string) {
        calls.push({ fn: "cancelTurn", userId, sessionId });
      },
      async setMode(userId: string, sessionId: string, mode: string) {
        calls.push({ fn: "setMode", userId, sessionId, mode });
      },
    } as unknown as AcpSessionService;
    return { service, calls };
  }

  test("session/cancel is a NOTIFICATION and stops the turn", async () => {
    // Not a request — ACP models cancellation as fire-and-forget, so the editor
    // never waits for an ack. Registering it as a request would mean an editor's
    // stop button hangs.
    const { service, calls } = verbFake();
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    await conn.agent.notify(AGENT_METHODS.session_cancel, { sessionId: "acps_test" });
    await Bun.sleep(20);

    expect(calls).toContainEqual({ fn: "cancelTurn", userId: "usr_1", sessionId: "acps_test" });
  });

  test("session/set_mode maps modeId onto our permission mode", async () => {
    const { service, calls } = verbFake();
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    await conn.agent.request(AGENT_METHODS.session_set_mode, {
      sessionId: "acps_test",
      modeId: "accept-edits",
    });

    expect(calls).toContainEqual({
      fn: "setMode",
      userId: "usr_1",
      sessionId: "acps_test",
      mode: "accept-edits",
    });
  });

  test("an unknown modeId is refused rather than silently ignored", async () => {
    // ACP's modeId is a free-form string; our modes are a fixed enum. Accepting
    // an unrecognised one would leave the editor believing it had loosened
    // permissions when nothing changed — the most dangerous possible direction
    // for that mistake.
    const { service, calls } = verbFake();
    const conn = connect(service);
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    await expect(
      conn.agent.request(AGENT_METHODS.session_set_mode, { sessionId: "acps_test", modeId: "yolo" }),
    ).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });
});
