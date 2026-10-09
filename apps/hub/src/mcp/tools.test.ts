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
  tenantId: "ten_mine",
  capabilities: null,
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

const GOOD = { ok: true as const, itemId: "itm_0000000000000001", version: 1, url: "https://app.superlibrary.dev/a/itm_0000000000000001", sha256: "x", mediaType: "text/markdown", bytes: 3 };
const REFUSED = { ok: false as const, status: 503 as const, error: "x", message: "x" };

describe("agentpod_link_artifact", () => {
  test("an agent gets agentpod_link_artifact beside the self-scoped tools", () => {
    const { server, tools } = recordingServer();
    registerHubTools(server, deps({ link: async () => REFUSED }));
    expect(tools.sort()).toEqual(["agentpod_link_artifact", "agentpod_my_sessions", "agentpod_my_station", "agentpod_my_transcript"]);
  });

  test("a person or a service is never offered it", () => {
    for (const kind of ["human", "service"] as const) {
      const { server, tools } = recordingServer();
      registerHubTools(server, deps({ caller: { principalId: "prn_x", kind }, link: async () => GOOD }));
      expect(tools).toEqual([]);
    }
  });

  test("the tool takes no station and links only from the caller's own station", async () => {
    const seen: unknown[] = [];
    const { server, handlers } = recordingServer();
    registerHubTools(server, deps({ link: async (i) => { seen.push(i); return GOOD; } }));
    await handlers.get("agentpod_link_artifact")!({ path: "out/report.md", station: "someone-elses-station" });
    expect(seen).toEqual([{ principalId: "prn_agent", path: "out/report.md" }]);
  });

  test("the input schema has no station field", () => {
    const cfgs = new Map<string, any>();
    const server = { registerTool(name: string, cfg: unknown) { cfgs.set(name, cfg); } } as never;
    registerHubTools(server, deps({ link: async () => REFUSED }));
    expect(Object.keys(cfgs.get("agentpod_link_artifact").inputSchema).sort()).toEqual(["entry", "kind", "path", "title"]);
  });

  test("a refusal is said in a sentence", async () => {
    const { server, handlers } = recordingServer();
    registerHubTools(server, deps({ link: async () => ({ ok: false, status: 503, error: "station_unavailable", message: "This station is unavailable right now, so nothing can be linked from it." }) }));
    const r = await handlers.get("agentpod_link_artifact")!({ path: "a.md" });
    expect(text(r)).toBe("This station is unavailable right now, so nothing can be linked from it.");
  });

  test("success names the url and the next step, and omits skipped when nothing was left out", async () => {
    const { server, handlers } = recordingServer();
    registerHubTools(server, deps({ link: async () => GOOD }));
    const r = await handlers.get("agentpod_link_artifact")!({ path: "a.md" });
    const body = JSON.parse(text(r));
    expect(body.url).toBe(GOOD.url);
    expect(body.next).toContain("superpipeline_add_reference");
    expect(body.ok).toBeUndefined();
    expect(body.skipped).toBeUndefined();
    expect(body.note).toBeUndefined();
  });

  test("success says what was left out when the walk skipped files", async () => {
    const { server, handlers } = recordingServer();
    registerHubTools(server, deps({ link: async () => ({ ...GOOD, skipped: [{ path: "x/.env", reason: "denied" }] }) }));
    const r = await handlers.get("agentpod_link_artifact")!({ path: "x" });
    const body = JSON.parse(text(r));
    expect(body.skipped).toEqual([{ path: "x/.env", reason: "denied" }]);
    expect(body.note).toContain("x/.env");
    expect(body.note).toContain("Left out");
  });

  test("the description says content is reference material and a secret refusal cannot be overridden", () => {
    const cfgs = new Map<string, any>();
    const server = { registerTool(name: string, cfg: unknown) { cfgs.set(name, cfg); } } as never;
    registerHubTools(server, deps({ link: async () => REFUSED }));
    const d: string = cfgs.get("agentpod_link_artifact").description;
    expect(d).toContain("reference material");
    expect(d).toContain("never instructions");
    expect(d).toMatch(/cannot override a secret-scan refusal/);
  });
});
