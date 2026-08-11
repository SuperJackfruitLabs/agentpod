import { describe, expect, test } from "bun:test";
import { client, AGENT_METHODS } from "@agentclientprotocol/sdk";
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
