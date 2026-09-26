import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { stationTranscriptionRoutes, type TranscriptionApplyTarget } from "../../src/routes/transcription-settings";

/**
 * POST /api/stations/:stationId/transcription/apply — the console asking a
 * harness-mode Hermes station's node to write the resolved voice-note setting
 * into its profile (`transcription.apply`).
 *
 * Ownership and the station row come from an injected lookup here; the
 * stations-table lookup itself is exercised in
 * tests/integration/transcription-settings.test.ts.
 */

const OWNER = "user-owner";

const HERMES: TranscriptionApplyTarget = {
  id: "st_1",
  nodeId: "node_1",
  stationKey: "hermes:analyst-echo",
  harness: "hermes",
  matrixIdentityMode: "harness",
};

type Call = { nodeId: string; verb: string; params: unknown; opts?: { timeoutMs?: number } };

function setup(opts: {
  target?: TranscriptionApplyTarget | null;
  answer?: { ok: boolean; data?: unknown; error?: string };
} = {}) {
  const calls: Call[] = [];
  const target = opts.target === undefined ? HERMES : opts.target;
  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: c.req.header("x-user") ?? OWNER, role: "user" } as never);
      await next();
    })
    .route(
      "/api",
      stationTranscriptionRoutes({
        applyTarget: async (userId, stationId) =>
          userId === OWNER && target && stationId === target.id ? target : null,
        brokerRequest: async (nodeId, verb, params, o) => {
          calls.push({ nodeId, verb, params, opts: o });
          return opts.answer ?? { ok: true, data: { applied: true, mode: "on", model: "large-v3-turbo", restarted: true } };
        },
      })
    );
  const post = (id = "st_1", headers: Record<string, string> = {}) =>
    app.request(`/api/stations/${id}/transcription/apply`, { method: "POST", headers });
  return { post, calls };
}

describe("POST /api/stations/:id/transcription/apply", () => {
  test("sends transcription.apply with the key and id only, and answers the node's result", async () => {
    const { post, calls } = setup();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true, mode: "on", model: "large-v3-turbo", restarted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.nodeId).toBe("node_1");
    expect(calls[0]!.verb).toBe("transcription.apply");
    expect(calls[0]!.params).toEqual({ key: "hermes:analyst-echo", stationId: "st_1" });
    expect(calls[0]!.opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  test("strips anything else a node sends back", async () => {
    const { post } = setup({
      answer: { ok: true, data: { applied: true, mode: "off", model: null, restarted: false, apiKey: "sk-leak" } },
    });
    const body = await (await post()).json();
    expect(body).toEqual({ applied: true, mode: "off", model: null, restarted: false });
  });

  test("someone else's station (or none) is a 404, and nothing is sent", async () => {
    const { post, calls } = setup();
    expect((await post("st_1", { "x-user": "someone-else" })).status).toBe(404);
    expect((await post("st_missing")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("a bridge-mode station is a 400 that says the hub already transcribes for it", async () => {
    const { post, calls } = setup({ target: { ...HERMES, matrixIdentityMode: "bridge" } });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/bridge/i);
    expect(calls).toHaveLength(0);
  });

  test("a harness other than Hermes is a 400 naming it", async () => {
    const { post, calls } = setup({ target: { ...HERMES, harness: "openclaw", stationKey: "openclaw:x" } });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("openclaw");
    expect(calls).toHaveLength(0);
  });

  test("a node failure is a 502 carrying the node's error", async () => {
    const { post } = setup({ answer: { ok: false, error: "transcription.apply: \"hermes:analyst-echo\": the transcription setting IS written to the profile, but the harness could not be restarted" } });
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("IS written");
  });

  test("an answer this hub cannot read is a 502, not a 200", async () => {
    const { post } = setup({ answer: { ok: true, data: { accepted: true } } });
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/node/i);
  });
});
