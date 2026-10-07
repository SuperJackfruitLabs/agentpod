import { describe, expect, test } from "bun:test";

import { PUSH_EVENTS, pushHookUrl, subscribeBoardsToPush } from "./push-subscription";

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

    expect(result).toEqual({ subscribed: ["brd_one", "brd_two"], failed: [] });
    expect(sent.map((s) => [s.method, s.url, s.auth])).toEqual([
      ["POST", `${BASE}/v1/boards/brd_one/push-configs`, "Bearer spa_one"],
      ["POST", `${BASE}/v1/boards/brd_two/push-configs`, "Bearer spa_two"],
    ]);
    // The `token` is the HMAC key superpipeline signs with, so it must be the secret the push
    // route verifies — not the agent's credential.
    expect(sent[0]!.body).toEqual({
      url: `${PUBLIC}/public/bridge/superpipeline/push`,
      token: "shh",
      events: ["gate.pending", "elicitation.pending"],
    });
  });

  test("subscribes to both events the push route projects", () => {
    expect([...PUSH_EVENTS].sort()).toEqual(["elicitation.pending", "gate.pending"]);
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
    expect(result).toEqual({ subscribed: [], failed: [] });
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
