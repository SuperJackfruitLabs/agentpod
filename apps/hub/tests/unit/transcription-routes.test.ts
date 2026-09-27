import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createTranscriptionSettings,
  type HubTranscriptionRecord,
  type StationTranscriptionRecord,
  type TranscriptionStore,
} from "../../src/services/transcription-settings";
import {
  adminTranscriptionRoutes,
  stationTranscriptionRoutes,
} from "../../src/routes/transcription-settings";
import { encrypt, decrypt } from "../../src/utils/encryption";

/**
 * The HTTP surface of the transcription settings, over an in-memory store.
 *
 * The admin router is mounted inside `adminRouter` in production, behind its
 * auth + admin guard; that the guard refuses a non-admin is asserted against a
 * real database in tests/integration/transcription-settings.test.ts. Station
 * ownership is decided by an injected lookup here and by the stations table
 * there.
 */

const KEY = "sk-test-not-a-real-key";
const OWNER = "user-owner";

function memoryStore(): TranscriptionStore & { hub: HubTranscriptionRecord | null } {
  const stations = new Map<string, StationTranscriptionRecord>();
  const s = {
    hub: null as HubTranscriptionRecord | null,
    async getHub() {
      return s.hub;
    },
    async setHub(rec: HubTranscriptionRecord) {
      s.hub = rec;
    },
    async getStation(id: string) {
      return stations.get(id) ?? null;
    },
    async setStation(id: string, rec: StationTranscriptionRecord) {
      stations.set(id, rec);
    },
  };
  return s;
}

function setup(opts: { env?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const store = memoryStore();
  const settings = createTranscriptionSettings({ store, env: opts.env ?? {}, cipher: { encrypt, decrypt } });
  const audited: string[] = [];
  const admin = new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: "admin-1", role: "admin" } as never);
      await next();
    })
    .route(
      "/settings/transcription",
      adminTranscriptionRoutes({
        settings,
        fetch: opts.fetch,
        audit: async (_adminId, summary) => {
          audited.push(summary);
        },
      })
    );
  const station = new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: c.req.header("x-user") ?? OWNER, role: "user" } as never);
      await next();
    })
    .route(
      "/api",
      stationTranscriptionRoutes({
        settings,
        ownsStation: async (userId, stationId) => userId === OWNER && stationId === "st_1",
      })
    );
  return { store, settings, admin, station, audited };
}

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("GET/PUT /api/admin/settings/transcription", () => {
  test("reads the env fallback before anything is saved", async () => {
    const { admin } = setup({ env: { TRANSCRIBE_URL: "http://100.78.52.87:8840", TRANSCRIBE_API_KEY: KEY } });
    const res = await admin.request("/settings/transcription");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      url: "http://100.78.52.87:8840",
      model: "large-v3-turbo",
      maxSeconds: 300,
      hasApiKey: true,
      source: "env",
    });
  });

  test("saves, answers with the view, never the key, and audits without it", async () => {
    const { admin, store, audited } = setup();
    const res = await admin.request(
      "/settings/transcription",
      json("PUT", { enabled: true, url: "https://api.openai.com", model: "whisper-1", maxSeconds: 120, apiKey: KEY })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(store.hub!.apiKeyEncrypted!);
    expect(JSON.parse(text)).toMatchObject({ enabled: true, url: "https://api.openai.com", hasApiKey: true, source: "settings" });
    expect(audited).toHaveLength(1);
    expect(audited[0]).not.toContain(KEY);
  });

  test("refuses a url that is not http(s)", async () => {
    const { admin } = setup();
    for (const url of ["ftp://x", "javascript:alert(1)", "not a url"]) {
      const res = await admin.request(
        "/settings/transcription",
        json("PUT", { enabled: true, url, model: "m", maxSeconds: 300 })
      );
      expect(res.status).toBe(400);
    }
  });

  test("refuses enabling with no url, and a length outside 10–600 s", async () => {
    const { admin } = setup();
    expect((await admin.request("/settings/transcription", json("PUT", { enabled: true, url: "", model: "m", maxSeconds: 300 }))).status).toBe(400);
    for (const maxSeconds of [9, 601, 30.5]) {
      const res = await admin.request(
        "/settings/transcription",
        json("PUT", { enabled: true, url: "http://t", model: "m", maxSeconds })
      );
      expect(res.status).toBe(400);
    }
  });

  test("disabled may be saved with no url", async () => {
    const { admin } = setup();
    const res = await admin.request("/settings/transcription", json("PUT", { enabled: false, url: "", model: "m", maxSeconds: 300 }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/settings/transcription/test", () => {
  function recordingFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; auth: string | null; model: unknown }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init.headers).get("Authorization"),
        model: (init.body as FormData).get("model"),
      });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  test("tests the saved config, with the saved key, when nothing is given", async () => {
    const { f, calls } = recordingFetch(200, { text: "" });
    const { admin } = setup({ fetch: f });
    await admin.request("/settings/transcription", json("PUT", { enabled: true, url: "http://saved", model: "saved-model", maxSeconds: 300, apiKey: KEY }));

    const res = await admin.request("/settings/transcription/test", json("POST", {}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(typeof body.elapsedMs).toBe("number");
    expect(calls[0]).toEqual({ url: "http://saved/v1/audio/transcriptions", auth: `Bearer ${KEY}`, model: "saved-model" });
  });

  test("tests what was typed over what is saved", async () => {
    const { f, calls } = recordingFetch(200, { text: "" });
    const { admin } = setup({ fetch: f });
    await admin.request("/settings/transcription", json("PUT", { enabled: true, url: "http://saved", model: "saved-model", maxSeconds: 300, apiKey: KEY }));

    await admin.request("/settings/transcription/test", json("POST", { url: "https://api.groq.com/openai", model: "whisper-large-v3-turbo" }));
    expect(calls[0]).toEqual({
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      auth: `Bearer ${KEY}`,
      model: "whisper-large-v3-turbo",
    });
  });

  test("reports a refusal, and the body never echoes the key", async () => {
    const { f } = recordingFetch(401, "invalid key");
    const { admin } = setup({ fetch: f });
    const res = await admin.request("/settings/transcription/test", json("POST", { url: "http://t", apiKey: KEY }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ ok: false, status: 401 });
  });

  test("with nothing saved and no url given, there is nothing to test", async () => {
    const { admin } = setup();
    const res = await admin.request("/settings/transcription/test", json("POST", {}));
    expect(res.status).toBe(400);
  });
});

describe("/api/stations/:id/transcription", () => {
  test("the owner reads the default: inherit, and the effective hub config", async () => {
    const { station } = setup({ env: { TRANSCRIBE_URL: "http://env" } });
    const res = await station.request("/api/stations/st_1/transcription");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "inherit",
      hasApiKey: false,
      effective: { enabled: true, url: "http://env", model: "large-v3-turbo", maxSeconds: 300, source: "env" },
    });
  });

  test("the owner sets a custom service; the key is not echoed", async () => {
    const { station } = setup();
    const res = await station.request(
      "/api/stations/st_1/transcription",
      json("PUT", { mode: "custom", url: "https://api.openai.com", model: "gpt-4o-transcribe", maxSeconds: 60, apiKey: KEY })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({
      mode: "custom",
      url: "https://api.openai.com",
      hasApiKey: true,
      effective: { enabled: true, source: "station", maxSeconds: 60 },
    });
  });

  test("someone else's station is a 404, read or write", async () => {
    const { station } = setup();
    expect((await station.request("/api/stations/st_1/transcription", { headers: { "x-user": "intruder" } })).status).toBe(404);
    expect(
      (await station.request("/api/stations/st_1/transcription", json("PUT", { mode: "off" }, { "x-user": "intruder" }))).status
    ).toBe(404);
    expect((await station.request("/api/stations/st_other/transcription")).status).toBe(404);
  });

  test("validation: mode, custom needs a url, url is http(s), bounds on length", async () => {
    const { station } = setup();
    const put = (body: unknown) => station.request("/api/stations/st_1/transcription", json("PUT", body));
    expect((await put({ mode: "sometimes" })).status).toBe(400);
    expect((await put({ mode: "custom" })).status).toBe(400);
    expect((await put({ mode: "custom", url: "file:///etc/passwd" })).status).toBe(400);
    expect((await put({ mode: "custom", url: "http://t", maxSeconds: 5 })).status).toBe(400);
    expect((await put({ mode: "off" })).status).toBe(200);
  });
});
