import { describe, expect, test } from "bun:test";

import { PUSH_EVENTS, RELAY_PUSH_EVENTS, pushHookUrl, subscribeBoardsToPush } from "./push-subscription";

/**
 * Nobody registered the hub's push subscription — so no board ever pushed a gate.
 *
 * The spec (approvals-over-chat §5.6) said "register the push config with superpipeline, and script
 * it so a rebuild does not silently lose the subscription". Neither happened: every gate reached
 * its room on the five-minute sweep, and the signed push route sat unused. The hub now registers
 * (and refreshes) one subscription per board it works, with each board's own credential.
 */

const BASE = "https://board.test";
const PUBLIC = "https://hub.test";

function recordingFetch(status = (_url: string) => 201) {
  const sent: Array<{ url: string; method: string; auth: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    sent.push({ url, method: init.method, auth: init.headers.Authorization ?? "", body: JSON.parse(init.body ?? "{}") });
    const s = status(url);
    return { status: s, ok: s < 400, json: async () => (s < 400 ? { configId: `push_${sent.length}` } : { error: "nope" }) };
  };
  return { sent, fetchImpl };
}

describe("subscribing each board to the hub's push", () => {
  test("registers the signed push route for gates and questions, once per board, with that board's token", async () => {
    const { sent, fetchImpl } = recordingFetch();
    const result = await subscribeBoardsToPush({
      baseUrl: BASE,
      publicUrl: PUBLIC,
      secret: "shh",
      fetch: fetchImpl,
      boards: async () =>
        new Map([
          ["brd_one", "spa_one"],
          ["brd_two", "spa_two"],
        ]),
    });

    expect(result).toEqual({ subscribed: ["brd_one", "brd_two"], relayed: [], failed: [] });
    expect(sent.map((s) => [s.method, s.url, s.auth])).toEqual([
      ["POST", `${BASE}/v1/boards/brd_one/push-configs`, "Bearer spa_one"],
      ["POST", `${BASE}/v1/boards/brd_two/push-configs`, "Bearer spa_two"],
    ]);
    // The `token` is the HMAC key superpipeline signs with, so it must be the secret the push
    // route verifies — not the agent's credential.
    expect(sent[0]!.body).toEqual({
      url: `${PUBLIC}/public/bridge/superpipeline/push`,
      token: "shh",
      events: ["gate.pending", "elicitation.pending", "delivery.pending", "attention.pending", "decision.reminded", "decision.escalated", "gate.approval_recorded", "decision.released", "decision.pulled_back", "check.failed", "check.overridden"],
    });
  });

  test("subscribes to every event the push route projects, the delivery follow-up, the timeouts, quorum progress, holds and checks included", () => {
    expect([...PUSH_EVENTS].sort()).toEqual([
      "attention.pending",
      "check.failed",
      "check.overridden",
      "decision.escalated",
      "decision.pulled_back",
      "decision.released",
      "decision.reminded",
      "delivery.pending",
      "elicitation.pending",
      "gate.approval_recorded",
      "gate.pending",
    ]);
  });

  test("the relay stays on the one event approval requests ride, so a timeout is not delivered twice", () => {
    expect([...RELAY_PUSH_EVENTS]).toEqual(["elicitation.pending"]);
  });

  test("registers nothing without a signing secret — the route would refuse every push", async () => {
    const { sent, fetchImpl } = recordingFetch();
    const result = await subscribeBoardsToPush({
      baseUrl: BASE,
      publicUrl: PUBLIC,
      secret: undefined,
      fetch: fetchImpl,
      boards: async () => new Map([["brd_one", "spa_one"]]),
    });

    expect(sent).toHaveLength(0);
    expect(result).toEqual({ subscribed: [], relayed: [], failed: [] });
  });

  test("one board refusing does not stop the others", async () => {
    const { fetchImpl } = recordingFetch((url) => (url.includes("brd_one") ? 401 : 201));
    const result = await subscribeBoardsToPush({
      baseUrl: BASE,
      publicUrl: PUBLIC,
      secret: "shh",
      fetch: fetchImpl,
      boards: async () =>
        new Map([
          ["brd_one", "spa_one"],
          ["brd_two", "spa_two"],
        ]),
    });

    expect(result.subscribed).toEqual(["brd_two"]);
    expect(result.failed.map((f) => f.boardId)).toEqual(["brd_one"]);
  });

  test("the hook URL tolerates a trailing slash on the public URL", () => {
    expect(pushHookUrl("https://hub.test/")).toBe("https://hub.test/public/bridge/superpipeline/push");
  });
});

describe("the relay's own push config, for approval requests", () => {
  test("a board of the relay's workspace also gets elicitation.pending registered with the relay token", async () => {
    const { sent, fetchImpl } = recordingFetch();
    const result = await subscribeBoardsToPush({
      baseUrl: BASE,
      publicUrl: PUBLIC,
      secret: "shh",
      fetch: fetchImpl,
      boards: async () =>
        new Map([
          ["brd_one", "spa_one"],
          ["brd_two", "spa_two"],
        ]),
      relayTokenFor: async (boardId) => (boardId === "brd_one" ? "relay.jwt.token" : null),
    });
    expect(result).toEqual({ subscribed: ["brd_one", "brd_two"], relayed: ["brd_one"], failed: [] });
    expect(sent.map((s) => [s.url, s.auth, s.body.events])).toEqual([
      [`${BASE}/v1/boards/brd_one/push-configs`, "Bearer spa_one", [...PUSH_EVENTS]],
      [`${BASE}/v1/boards/brd_one/push-configs`, "Bearer relay.jwt.token", ["elicitation.pending"]],
      [`${BASE}/v1/boards/brd_two/push-configs`, "Bearer spa_two", [...PUSH_EVENTS]],
    ]);
    expect(sent[1]?.body.token).toBe("shh");
  });

  test("a refused relay registration is reported without costing the board its own subscription", async () => {
    const { fetchImpl } = recordingFetch();
    let call = 0;
    const result = await subscribeBoardsToPush({
      baseUrl: BASE,
      publicUrl: PUBLIC,
      secret: "shh",
      fetch: async (url, init) => (++call === 2 ? { status: 403, ok: false, json: async () => ({ error: { code: "FORBIDDEN" } }) } : fetchImpl(url, init)),
      boards: async () => new Map([["brd_one", "spa_one"]]),
      relayTokenFor: async () => "relay.jwt.token",
    });
    expect(result.subscribed).toEqual(["brd_one"]);
    expect(result.relayed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toStartWith("relay: ");
  });

  test("a 401/403 on the relay's registration makes the relay forget its token", async () => {
    let refused = 0;
    let call = 0;
    const { fetchImpl } = recordingFetch();
    await subscribeBoardsToPush({
      baseUrl: BASE,
      publicUrl: PUBLIC,
      secret: "shh",
      fetch: async (url, init) => (++call === 2 ? { status: 401, ok: false, json: async () => ({ error: { code: "UNAUTHORIZED" } }) } : fetchImpl(url, init)),
      boards: async () => new Map([["brd_one", "spa_one"]]),
      relayTokenFor: async () => "relay.jwt.token",
      onRelayRefused: () => {
        refused++;
      },
    });
    expect(refused).toBe(1);
  });
});
