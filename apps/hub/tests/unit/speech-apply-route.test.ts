import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { stationSpeechRoutes } from "../../src/routes/speech-settings";
import type { TranscriptionApplyTarget } from "../../src/routes/transcription-settings";

/**
 * POST /api/stations/:stationId/speech/apply — the console asking a
 * harness-mode Hermes station's node to write the resolved spoken-reply
 * setting into its profile (`speech.apply`).
 *
 * Ownership and the station row come from an injected lookup here; the
 * stations-table lookup is exercised in tests/integration/speech-settings.test.ts.
 */

const OWNER = "user-owner";

const HERMES: TranscriptionApplyTarget = {
  id: "st_1",
  nodeId: "node_1",
  stationKey: "hermes:writer-quill",
  harness: "hermes",
  matrixIdentityMode: "harness",
};

const APPLIED = {
  applied: true,
  mode: "on",
  voice: "af_heart:60+af_bella:40",
  speakMode: "always",
  autoSpeak: true,
  restarted: true,
};

type Call = { nodeId: string; verb: string; params: unknown; opts?: { timeoutMs?: number } };

function setup(
  opts: {
    target?: TranscriptionApplyTarget | null;
    answer?: { ok: boolean; data?: unknown; error?: string };
  } = {}
) {
  const calls: Call[] = [];
  const logged: string[] = [];
  const target = opts.target === undefined ? HERMES : opts.target;
  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: c.req.header("x-user") ?? OWNER, role: "user" } as never);
      await next();
    })
    .route(
      "/api",
      stationSpeechRoutes({
        applyTarget: async (userId, stationId) =>
          userId === OWNER && target && stationId === target.id ? target : null,
        brokerRequest: async (nodeId, verb, params, o) => {
          calls.push({ nodeId, verb, params, opts: o });
          return opts.answer ?? { ok: true, data: APPLIED };
        },
      })
    );
  const post = (id = "st_1", headers: Record<string, string> = {}) =>
    app.request(`/api/stations/${id}/speech/apply`, { method: "POST", headers });
  return { post, calls, logged };
}

describe("POST /api/stations/:id/speech/apply", () => {
  test("sends speech.apply with the key and id only, and answers the node's result", async () => {
    const { post, calls } = setup();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(APPLIED);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.nodeId).toBe("node_1");
    expect(calls[0]!.verb).toBe("speech.apply");
    expect(calls[0]!.params).toEqual({ key: "hermes:writer-quill", stationId: "st_1" });
    expect(calls[0]!.opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  test("strips anything else a node sends back", async () => {
    const { post } = setup({ answer: { ok: true, data: { ...APPLIED, apiKey: "sk-leak", url: "http://x:8841/v1" } } });
    expect(await (await post()).json()).toEqual(APPLIED);
  });

  test("someone else's station (or none) is a 404, and nothing is sent", async () => {
    const { post, calls } = setup();
    expect((await post("st_1", { "x-user": "someone-else" })).status).toBe(404);
    expect((await post("st_missing")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("a bridge-mode station is a 400 that says the hub already speaks for it", async () => {
    const { post, calls } = setup({ target: { ...HERMES, matrixIdentityMode: "bridge" } });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/bridge-mode.*hub speaks/i);
    expect(calls).toHaveLength(0);
  });

  test("a harness-mode OpenClaw station is a 400 that says it is not supported yet", async () => {
    const { post, calls } = setup({ target: { ...HERMES, harness: "openclaw", stationKey: "openclaw:x" } });
    const res = await post();
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("openclaw");
    expect(error).toMatch(/not supported yet/i);
    expect(calls).toHaveLength(0);
  });

  test("a node failure is a 502 carrying the node's error", async () => {
    const { post } = setup({
      answer: { ok: false, error: 'speech.apply: "hermes:writer-quill": the speech setting IS written to the profile, but the harness could not be restarted' },
    });
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("IS written");
  });

  test("a node too old to know the verb is a 502 that says to update it", async () => {
    const { post } = setup({ answer: { ok: false, error: 'descriptor: unknown verb "speech.apply"' } });
    const res = await post();
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toMatch(/predates/i);
    expect(error).toMatch(/update/i);
  });

  test("an answer this hub cannot read is a 502, not a 200", async () => {
    const { post } = setup({ answer: { ok: true, data: { applied: true, mode: "on", model: "m", restarted: true } } });
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/node/i);
  });
});
