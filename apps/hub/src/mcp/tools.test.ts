/**
 * What each kind of principal is OFFERED.
 *
 * The rule this file guards: the caller's kind decides the tool set once, at registration. An
 * agent is never offered a tool it must not call, rather than being refused inside one — because
 * a check inside a handler is a check that one handler out of nine can be written without, which
 * is precisely the failure the route audit found in the HTTP routes.
 *
 * So the assertions are mostly about ABSENCE, which is the property that is easy to lose and
 * hard to notice.
 */
import { describe, expect, test } from "bun:test";

import { registerHubTools, type ToolDeps } from "./tools";
import type { SelfStation } from "../services/self-station";

/** A stand-in for McpServer that records what was registered. */
function recordingServer() {
  const tools: string[] = [];
  const handlers = new Map<string, (args: any) => Promise<any>>();
  return {
    tools,
    handlers,
    server: {
      registerTool(name: string, _cfg: unknown, handler: (args: any) => Promise<any>) {
        tools.push(name);
        handlers.set(name, handler);
      },
    } as never,
  };
}

const STATION: SelfStation = {
  id: "station_mine",
  stationKey: "opencode:mine",
  nodeId: "nod_1",
  nodeName: "box",
  nodeStatus: "offline", // offline on purpose: no broker call, so these tests need no node
  harness: "opencode",
  matrixId: "@agent_mine:id.example",
  identityMode: "bridge",
  ownerUserId: "usr_owner",
};

const deps = (over: Partial<ToolDeps> = {}): ToolDeps => ({
  caller: { principalId: "prn_agent", kind: "agent" },
  station: async () => STATION,
  ...over,
});

const text = (res: any): string => res.content.map((c: any) => c.text).join("\n");

describe("who is offered what", () => {
  test("an agent gets the self-scoped tools, and only those", () => {
    const { server, tools } = recordingServer();
    registerHubTools(server, deps());

    expect(tools.sort()).toEqual([
      "agentpod_my_sessions",
      "agentpod_my_station",
      "agentpod_my_transcript",
    ]);
  });

  test("no agent tool takes a station id — the property the route audit asked for", () => {
    // A tool that cannot be given a station id cannot be pointed at somebody else's. The one id
    // in the set is a SESSION id, on the transcript, and that one checks ownership.
    const { server, tools } = recordingServer();
    registerHubTools(server, deps());
    expect(tools).not.toContain("agentpod_station");
    for (const name of tools) {
      expect(name.startsWith("agentpod_my_"), `${name} should be self-scoped`).toBe(true);
    }
  });

  test("a human is offered no self-scoped tools — they occupy no station", () => {
    const { server, tools } = recordingServer();
    registerHubTools(server, deps({ caller: { principalId: "prn_human", kind: "human" } }));
    expect(tools).toEqual([]);
  });

  test("a service principal gets nothing either", () => {
    // Not "not-agent": the rule is the kinds that are explicitly handled, and a service is not.
    const { server, tools } = recordingServer();
    registerHubTools(server, deps({ caller: { principalId: "prn_svc", kind: "service" } }));
    expect(tools).toEqual([]);
  });
});

describe("an agent with no station", () => {
  test("is told so plainly, rather than erroring", async () => {
    // Between assignments is an ordinary state. Turning it into a fault makes every caller write
    // error handling for a normal day.
    const { server, handlers } = recordingServer();
    registerHubTools(server, deps({ station: async () => null }));

    for (const name of ["agentpod_my_station", "agentpod_my_sessions"]) {
      const res = await handlers.get(name)!({});
      expect(text(res)).toContain("not currently placed");
    }
  });
});

describe("agentpod_my_transcript — the one id in the set", () => {
  test("refuses a session that is not the caller's", async () => {
    const { server, handlers } = recordingServer();
    registerHubTools(server, deps());

    // `readEvents` takes a bare session id and scopes on nothing, so the check has to happen in
    // the tool. A session resolved under another owner comes back null and must be refused.
    const res = await handlers.get("agentpod_my_transcript")!({ sessionId: "ses_not_mine" });
    expect(text(res)).toContain("not one of yours");
  });

  test("refuses a session belonging to a different station of the same owner", async () => {
    // Owner-scoping alone is not enough: one operator can own many stations, and a transcript
    // from a sibling station is still not this agent's.
    const { server, handlers } = recordingServer();
    registerHubTools(server, deps());
    const res = await handlers.get("agentpod_my_transcript")!({ sessionId: "ses_sibling" });
    expect(text(res)).toContain("not one of yours");
  });
});

describe("agentpod_my_station", () => {
  test("reports the station and node without calling a node that is offline", async () => {
    // A broker request to an offline node is a timeout the caller waits out for no information;
    // the node's own status already answered the question.
    let healthCalled = false;
    const { server, handlers } = recordingServer();
    registerHubTools(
      server,
      deps({
        health: async () => {
          healthCalled = true;
          return { ok: true };
        },
      }),
    );
    const res = await handlers.get("agentpod_my_station")!({});
    const body = JSON.parse(text(res));

    expect(body.station.key).toBe("opencode:mine");
    expect(body.node.status).toBe("offline");
    expect(healthCalled, "an injected health probe is used when provided").toBe(true);
  });
});
