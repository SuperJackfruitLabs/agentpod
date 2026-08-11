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
        emit?.({ type: "agent-update", seq: 1, payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
        // The turn ends on an idle state event, exactly as the real service
        // signals it. Without this the agent waits forever, correctly.
        emit?.({ type: "state", seq: 2, payload: { status: "idle" } });
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
    let idle: (() => void) | undefined;
    const service: AcpSessionService = {
      async createSession() {
        return { id: "acps_test" };
      },
      subscribe(_s: string, fn: (e: { type: string; seq: number; payload: unknown }) => void) {
        idle = () => fn({ type: "state", seq: 1, payload: { status: "idle" } });
        return () => {};
      },
      async promptSession(_u, _s, text) {
        seen = text;
        idle?.();
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
        emit?.({ type: "state", seq: 99, payload: { status: "idle" } });
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

describe("hub ACP agent — session/load", () => {
  const HISTORY = [
    { seq: 1, type: "user-prompt", payload: { text: "hello" } },
    { seq: 2, type: "agent-update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    { seq: 3, type: "permission-request", payload: { toolCall: { toolCallId: "t1" }, options: [] } },
    { seq: 4, type: "agent-update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " there" } } },
    { seq: 5, type: "state", payload: { status: "idle" } },
  ];

  function loadFake(history = HISTORY) {
    const calls: Array<Record<string, unknown>> = [];
    const service = {
      async createSession() { return { id: "acps_test" }; },
      subscribe() { return () => {}; },
      async promptSession() {},
      async answerPermission() {},
      async cancelTurn() {},
      async setMode() {},
      async readEvents(sessionId: string, sinceSeq: number) {
        calls.push({ fn: "readEvents", sessionId, sinceSeq });
        return history.filter((e) => e.seq > sinceSeq);
      },
    } as unknown as AcpSessionService;
    return { service, calls };
  }

  async function connectCollecting(service: AcpSessionService) {
    const updates: Array<Record<string, unknown>> = [];
    const conn = client()
      .onNotification(CLIENT_METHODS.session_update, async ({ params }) => {
        updates.push(params as Record<string, unknown>);
      })
      .connect(buildAcpAgent({ userId: "usr_1", stationId: "station_1", sessions: service }));
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });
    return { conn, updates };
  }

  test("streams the stored transcript back before returning", async () => {
    // The protocol is explicit: on load the agent must "stream the entire
    // conversation history back to the client via notifications". An editor
    // that attaches and sees a blank pane has reached a fresh agent, not the
    // one it asked for — which would defeat the point of Doors.
    const { service } = loadFake();
    const { conn, updates } = await connectCollecting(service);

    await conn.agent.request(AGENT_METHODS.session_load, {
      sessionId: "acps_test",
      cwd: "/tmp",
      mcpServers: [],
    });

    expect(updates.length).toBeGreaterThan(0);
  });

  test("replays only the frames an editor can render, in order", async () => {
    // Same filter as the live path: agent-update carries a raw ACP
    // sessionUpdate, the hub's own types do not.
    const { service } = loadFake();
    const { conn, updates } = await connectCollecting(service);

    await conn.agent.request(AGENT_METHODS.session_load, {
      sessionId: "acps_test",
      cwd: "/tmp",
      mcpServers: [],
    });

    expect(updates).toHaveLength(2);
    const texts = updates.map((u) => ((u.update as Record<string, any>).content?.text));
    expect(texts).toEqual(["hi", " there"]);
  });

  test("reads the whole transcript, not a tail", async () => {
    const { service, calls } = loadFake();
    const { conn } = await connectCollecting(service);

    await conn.agent.request(AGENT_METHODS.session_load, {
      sessionId: "acps_test",
      cwd: "/tmp",
      mcpServers: [],
    });

    expect(calls).toContainEqual({ fn: "readEvents", sessionId: "acps_test", sinceSeq: 0 });
  });

  test("an empty transcript loads cleanly rather than erroring", async () => {
    // A session opened but never prompted is legitimate.
    const { service } = loadFake([]);
    const { conn, updates } = await connectCollecting(service);

    await conn.agent.request(AGENT_METHODS.session_load, {
      sessionId: "acps_test",
      cwd: "/tmp",
      mcpServers: [],
    });

    expect(updates).toHaveLength(0);
  });
});

describe("hub ACP agent — concurrent attach", () => {
  test("two agents on one session both receive live events", async () => {
    // The hub has always fanned out to N subscribers; the console was simply
    // the only client. Doors makes that real, so it gets a test.
    const subscribers: Array<(e: { type: string; seq: number; payload: unknown }) => void> = [];
    const service = {
      async createSession() { return { id: "acps_test" }; },
      subscribe(_s: string, fn: (e: { type: string; seq: number; payload: unknown }) => void) {
        subscribers.push(fn);
        return () => {
          const i = subscribers.indexOf(fn);
          if (i >= 0) subscribers.splice(i, 1);
        };
      },
      async promptSession() {
        subscribers.forEach((fn) =>
          fn({ type: "agent-update", seq: 1, payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "shared" } } }),
        );
        await Bun.sleep(20);
        subscribers.forEach((fn) => fn({ type: "state", seq: 2, payload: { status: "idle" } }));
      },
      async answerPermission() {}, async cancelTurn() {}, async setMode() {},
      async readEvents() { return []; },
    } as unknown as AcpSessionService;

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const mk = (sink: unknown[]) =>
      client()
        .onNotification(CLIENT_METHODS.session_update, async ({ params }) => { sink.push(params); })
        .connect(buildAcpAgent({ userId: "usr_1", stationId: "station_1", sessions: service }));

    const a = mk(seenA);
    const b = mk(seenB);
    await a.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await b.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    // B is mid-turn (subscribed) when A prompts, so both see A's event.
    const bTurn = b.agent.request(AGENT_METHODS.session_prompt, { sessionId: "acps_test", prompt: [{ type: "text", text: "b" }] });
    await Bun.sleep(5);
    await a.agent.request(AGENT_METHODS.session_prompt, { sessionId: "acps_test", prompt: [{ type: "text", text: "a" }] });
    await bTurn;

    expect(seenA.length).toBeGreaterThan(0);
    expect(seenB.length).toBeGreaterThan(0);
  });
});

describe("hub ACP agent — the turn outlives promptSession", () => {
  /**
   * Regression for the bug a real editor found: Zed showed its own prompts and
   * no replies at all, while the console watching the SAME session saw
   * everything.
   *
   * promptSession resolves when the prompt is DISPATCHED, not when the turn
   * ends — acp-sessions says so: "the turn runs in the background; callers
   * observe progress via subscribe()/acp_events, not this promise". Unsubscribing
   * when it resolves means the agent stops listening before the harness has said
   * a word.
   *
   * The earlier fake hid this by emitting synchronously and then sleeping. A
   * fake that resolves differently from the real thing tests nothing, so this
   * one resolves immediately and emits afterwards, exactly like production.
   */
  function realisticFake() {
    let emit: ((e: { type: string; seq: number; payload: unknown }) => void) | undefined;
    let unsubscribed = false;
    const service = {
      async createSession() { return { id: "acps_test" }; },
      subscribe(_s: string, fn: (e: { type: string; seq: number; payload: unknown }) => void) {
        emit = fn;
        return () => { unsubscribed = true; };
      },
      async promptSession() {
        // Returns immediately. The turn has NOT started producing output yet.
      },
      async answerPermission() {}, async cancelTurn() {}, async setMode() {},
      async readEvents() { return []; },
    } as unknown as AcpSessionService;

    const chunk = (text: string, seq: number) =>
      emit?.({ type: "agent-update", seq, payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    const finish = (seq: number) => emit?.({ type: "state", seq, payload: { status: "idle" } });

    return { service, chunk, finish, wasUnsubscribed: () => unsubscribed };
  }

  test("output produced after promptSession resolves still reaches the editor", async () => {
    const { service, chunk, finish } = realisticFake();
    const updates: unknown[] = [];
    const conn = client()
      .onNotification(CLIENT_METHODS.session_update, async ({ params }) => { updates.push(params); })
      .connect(buildAcpAgent({ userId: "usr_1", stationId: "station_1", sessions: service }));
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    const turn = conn.agent.request(AGENT_METHODS.session_prompt, {
      sessionId: "acps_test",
      prompt: [{ type: "text", text: "hello" }],
    });

    // The harness replies well after the dispatch call returned.
    await Bun.sleep(30);
    chunk("Hello! What would you", 1);
    chunk(" like to work on?", 2);
    finish(3);

    await turn;
    expect(updates).toHaveLength(2);
  });

  test("session/prompt does not return until the turn actually ends", async () => {
    // Returning end_turn immediately tells the editor the agent is done while
    // it is still thinking, which is how a reply arrives into a closed turn.
    const { service, chunk, finish } = realisticFake();
    const conn = client()
      .onNotification(CLIENT_METHODS.session_update, async () => {})
      .connect(buildAcpAgent({ userId: "usr_1", stationId: "station_1", sessions: service }));
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    let settled = false;
    const turn = conn.agent
      .request(AGENT_METHODS.session_prompt, { sessionId: "acps_test", prompt: [{ type: "text", text: "hi" }] })
      .then((r) => { settled = true; return r; });

    await Bun.sleep(40);
    expect(settled).toBe(false); // still working

    chunk("done", 1);
    finish(2);
    await turn;
    expect(settled).toBe(true);
  });

  test("it unsubscribes once the turn ends, not before", async () => {
    const { service, chunk, finish, wasUnsubscribed } = realisticFake();
    const conn = client()
      .onNotification(CLIENT_METHODS.session_update, async () => {})
      .connect(buildAcpAgent({ userId: "usr_1", stationId: "station_1", sessions: service }));
    await conn.agent.request(AGENT_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} });

    const turn = conn.agent.request(AGENT_METHODS.session_prompt, { sessionId: "acps_test", prompt: [{ type: "text", text: "hi" }] });
    await Bun.sleep(20);
    expect(wasUnsubscribed()).toBe(false);

    chunk("x", 1);
    finish(2);
    await turn;
    expect(wasUnsubscribed()).toBe(true);
  });
});
