import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  assignedVoiceFor,
  createSpeechSettings,
  type HubSpeechRecord,
  type SpeechStore,
  type StationSpeechRecord,
} from "../../src/services/speech-settings";
import { adminSpeechRoutes, speechVoicesRoutes, stationSpeechRoutes } from "../../src/routes/speech-settings";
import { encrypt, decrypt } from "../../src/utils/encryption";

/**
 * The HTTP surface of the speech settings, over an in-memory store. The admin
 * router sits inside `adminRouter` in production (auth + admin guard, asserted
 * in tests/integration/speech-settings.test.ts); ownership is injected here.
 */

const KEY = "sk-test-not-a-real-key";
const OWNER = "user-owner";
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2]);

function memoryStore(): SpeechStore & { hub: HubSpeechRecord | null } {
  const stations = new Map<string, StationSpeechRecord>();
  const s = {
    hub: null as HubSpeechRecord | null,
    async getHub() {
      return s.hub;
    },
    async setHub(rec: HubSpeechRecord) {
      s.hub = rec;
    },
    async getStation(id: string) {
      return stations.get(id) ?? null;
    },
    async setStation(id: string, rec: StationSpeechRecord) {
      stations.set(id, rec);
    },
  };
  return s;
}

const VOICES = {
  voices: [
    { id: "af_heart", name: "Heart", accent: "US", gender: "female", grade: "A", preview_url: "/v1/voices/af_heart/preview" },
    { id: "bm_george", name: "George", accent: "UK", gender: "male", grade: "C", preview_url: "/v1/voices/bm_george/preview" },
  ],
  default: "af_heart",
  aliases: { alloy: "af_heart" },
};

function serviceFetch(opts: { status?: number } = {}) {
  const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      auth: new Headers(init.headers).get("Authorization"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (opts.status && opts.status !== 200) return new Response('{"detail":"no"}', { status: opts.status });
    if (url.endsWith("/v1/voices")) return Response.json(VOICES);
    return new Response(OGG, { headers: { "content-type": "audio/ogg", "x-audio-duration-ms": "2100" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function setup(opts: { env?: Record<string, string>; fetch?: typeof fetch; now?: () => number } = {}) {
  const store = memoryStore();
  const settings = createSpeechSettings({ store, env: opts.env ?? {}, cipher: { encrypt, decrypt } });
  const audited: string[] = [];
  const admin = new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: "admin-1", role: "admin" } as never);
      await next();
    })
    .route(
      "/settings/speech",
      adminSpeechRoutes({
        settings,
        fetch: opts.fetch,
        audit: async (_adminId, summary) => {
          audited.push(summary);
        },
      })
    );
  const station = new Hono()
    .use("*", async (c, next) => {
      const who = c.req.header("x-user");
      if (who === "nobody") return c.json({ error: "Unauthorized" }, 401);
      c.set("user", { id: who ?? OWNER, role: "user" } as never);
      await next();
    })
    .route(
      "/api",
      stationSpeechRoutes({
        settings,
        ownsStation: async (userId, stationId) => userId === OWNER && stationId === "st_1",
      })
    )
    .route("/api", speechVoicesRoutes({ settings, fetch: opts.fetch, now: opts.now }));
  return { store, settings, admin, station, audited };
}

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const HUB = { enabled: true, url: "http://100.78.52.87:8841", defaultVoice: "", mode: "voice_in", maxChars: 1500 };

describe("GET/PUT /api/admin/settings/speech", () => {
  test("reads the env fallback before anything is saved", async () => {
    const { admin } = setup({ env: { SPEECH_URL: "http://100.78.52.87:8841", SPEECH_API_KEY: KEY } });
    const res = await admin.request("/settings/speech");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toEqual({
      enabled: true,
      url: "http://100.78.52.87:8841",
      defaultVoice: "",
      mode: "voice_in",
      maxChars: 1500,
      hasApiKey: true,
      source: "env",
    });
  });

  test("saves, answers with the view, never the key, and audits without it", async () => {
    const { admin, store, audited } = setup();
    const res = await admin.request("/settings/speech", json("PUT", { ...HUB, apiKey: KEY }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(store.hub!.apiKeyEncrypted!);
    expect(JSON.parse(text)).toMatchObject({ enabled: true, hasApiKey: true, source: "settings" });
    expect(audited).toHaveLength(1);
    expect(audited[0]).not.toContain(KEY);
    expect(JSON.parse(audited[0]!)).toMatchObject({ apiKey: "replaced", mode: "voice_in" });
  });

  test("validation: http(s) url, a speak mode, a voice id or blend, bounds on length", async () => {
    const { admin } = setup();
    const put = (body: unknown) => admin.request("/settings/speech", json("PUT", body));
    expect((await put({ ...HUB, url: "ftp://x" })).status).toBe(400);
    expect((await put({ ...HUB, url: "" })).status).toBe(400);
    expect((await put({ ...HUB, mode: "sometimes" })).status).toBe(400);
    expect((await put({ ...HUB, maxChars: 99 })).status).toBe(400);
    expect((await put({ ...HUB, maxChars: 4097 })).status).toBe(400);
    expect((await put({ ...HUB, defaultVoice: "x".repeat(65) })).status).toBe(400);
    expect((await put({ ...HUB, defaultVoice: "<script>" })).status).toBe(400);
    expect((await put({ ...HUB, defaultVoice: "af_heart:60+af_bella:40" })).status).toBe(200);
    expect((await put({ ...HUB, enabled: false, url: "" })).status).toBe(200);
  });
});

describe("POST /api/admin/settings/speech/test", () => {
  test("speaks a sentence with the saved key and reports ok, status, elapsed, duration and the clip", async () => {
    const { f, calls } = serviceFetch();
    const { admin } = setup({ fetch: f });
    await admin.request("/settings/speech", json("PUT", { ...HUB, apiKey: KEY }));
    const res = await admin.request("/settings/speech/test", json("POST", {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: 200, durationMs: 2100 });
    expect(typeof body.elapsedMs).toBe("number");
    expect(body.audio).toBe(Buffer.from(OGG).toString("base64"));
    expect(calls[0]!.url).toBe("http://100.78.52.87:8841/v1/audio/speech");
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  test("tests typed values and a chosen voice", async () => {
    const { f, calls } = serviceFetch();
    const { admin } = setup({ fetch: f });
    await admin.request("/settings/speech/test", json("POST", { url: "http://typed:8841", apiKey: "typed", voice: "bm_george" }));
    expect(calls[0]!.url).toBe("http://typed:8841/v1/audio/speech");
    expect(calls[0]!.auth).toBe("Bearer typed");
    expect(calls[0]!.body).toMatchObject({ voice: "bm_george" });
  });

  test("a refusal is reported, and never echoes the key", async () => {
    const { f } = serviceFetch({ status: 401 });
    const { admin } = setup({ fetch: f });
    const res = await admin.request("/settings/speech/test", json("POST", { url: "http://t", apiKey: KEY }));
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ ok: false, status: 401 });
  });

  test("nothing saved and no url given: nothing to test", async () => {
    const { admin } = setup();
    expect((await admin.request("/settings/speech/test", json("POST", {}))).status).toBe(400);
  });
});

describe("/api/stations/:id/speech", () => {
  test("the owner reads the default: inherit, the assigned voice, and what is in effect", async () => {
    const { station } = setup({ env: { SPEECH_URL: "http://env:8841" } });
    const res = await station.request("/api/stations/st_1/speech");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "inherit",
      hasApiKey: false,
      assignedVoice: assignedVoiceFor("st_1"),
      effective: {
        enabled: true,
        url: "http://env:8841",
        voice: assignedVoiceFor("st_1"),
        voiceSource: "assigned",
        speakMode: "voice_in",
        maxChars: 1500,
        source: "env",
      },
    });
  });

  test("the owner picks a voice and a speak mode without naming a service", async () => {
    const { station } = setup({ env: { SPEECH_URL: "http://env:8841" } });
    const res = await station.request(
      "/api/stations/st_1/speech",
      json("PUT", { mode: "inherit", voice: "bm_george", speakMode: "always" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      voice: "bm_george",
      speakMode: "always",
      effective: { voice: "bm_george", voiceSource: "station", speakMode: "always", source: "env" },
    });
  });

  test("a custom service's key is not echoed", async () => {
    const { station } = setup();
    const res = await station.request(
      "/api/stations/st_1/speech",
      json("PUT", { mode: "custom", url: "https://api.openai.com", apiKey: KEY })
    );
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ mode: "custom", hasApiKey: true, effective: { source: "station" } });
  });

  test("someone else's station is a 404, read or write", async () => {
    const { station } = setup();
    expect((await station.request("/api/stations/st_1/speech", { headers: { "x-user": "intruder" } })).status).toBe(404);
    expect((await station.request("/api/stations/st_1/speech", json("PUT", { mode: "off" }, { "x-user": "intruder" }))).status).toBe(404);
  });

  test("validation", async () => {
    const { station } = setup();
    const put = (body: unknown) => station.request("/api/stations/st_1/speech", json("PUT", body));
    expect((await put({ mode: "sometimes" })).status).toBe(400);
    expect((await put({ mode: "custom" })).status).toBe(400);
    expect((await put({ mode: "custom", url: "file:///etc/passwd" })).status).toBe(400);
    expect((await put({ mode: "inherit", speakMode: "loud" })).status).toBe(400);
    expect((await put({ mode: "inherit", voice: "a b/c" })).status).toBe(400);
    expect((await put({ mode: "inherit", voice: null, speakMode: null })).status).toBe(200);
  });
});

describe("/api/speech/voices — the voice list and previews, through the hub", () => {
  test("lists the service's voices with the hub's own preview urls, and the assignable list", async () => {
    const { f, calls } = serviceFetch();
    const { station } = setup({ env: { SPEECH_URL: "http://env:8841", SPEECH_API_KEY: KEY }, fetch: f });
    const res = await station.request("/api/speech/voices");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("env:8841");
    const body = JSON.parse(text);
    expect(body.voices[0]).toEqual({ ...VOICES.voices[0], preview_url: "/api/speech/voices/af_heart/preview" });
    expect(body.default).toBe("af_heart");
    expect(body.assignable).toHaveLength(15);
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  test("cached for about five minutes", async () => {
    const { f, calls } = serviceFetch();
    let t = 0;
    const { station } = setup({ env: { SPEECH_URL: "http://env:8841" }, fetch: f, now: () => t });
    await station.request("/api/speech/voices");
    await station.request("/api/speech/voices");
    expect(calls).toHaveLength(1);
    t = 5 * 60_000 + 1;
    await station.request("/api/speech/voices");
    expect(calls).toHaveLength(2);
  });

  test("a failed fetch is a 502 and is not cached", async () => {
    const bad = serviceFetch({ status: 500 });
    const { station } = setup({ env: { SPEECH_URL: "http://env:8841" }, fetch: bad.f });
    expect((await station.request("/api/speech/voices")).status).toBe(502);
    expect((await station.request("/api/speech/voices")).status).toBe(502);
    expect(bad.calls).toHaveLength(2);
  });

  test("no service configured is a 503", async () => {
    const { station } = setup();
    expect((await station.request("/api/speech/voices")).status).toBe(503);
  });

  test("a preview streams the Ogg through, with cache headers", async () => {
    const { f, calls } = serviceFetch();
    const { station } = setup({ env: { SPEECH_URL: "http://env:8841", SPEECH_API_KEY: KEY }, fetch: f });
    const res = await station.request("/api/speech/voices/bm_george/preview");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/ogg");
    expect(res.headers.get("cache-control")).toContain("max-age");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(OGG);
    expect(calls[0]!.url).toBe("http://env:8841/v1/voices/bm_george/preview");
  });

  test("a voice id that is not one is refused before anything is fetched", async () => {
    const { f, calls } = serviceFetch();
    const { station } = setup({ env: { SPEECH_URL: "http://env:8841" }, fetch: f });
    expect((await station.request("/api/speech/voices/..%2F..%2Fhealth/preview")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("unauthenticated callers are refused by the auth in front (here: the stand-in)", async () => {
    const { station } = setup({ env: { SPEECH_URL: "http://env:8841" } });
    expect((await station.request("/api/speech/voices", { headers: { "x-user": "nobody" } })).status).toBe(401);
  });
});
