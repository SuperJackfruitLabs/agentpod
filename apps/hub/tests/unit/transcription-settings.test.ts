import { describe, expect, test } from "bun:test";
import {
  createTranscriptionSettings,
  type HubTranscriptionRecord,
  type StationTranscriptionRecord,
  type TranscriptionStore,
} from "../../src/services/transcription-settings";
import { encrypt, decrypt } from "../../src/utils/encryption";

/**
 * Where a voice note's transcription service comes from.
 *
 * Precedence, most specific first: the station's own custom service, then the
 * station saying "off", then the hub-wide settings an admin saved, then the
 * TRANSCRIBE_* environment the hub was started with, then nothing. The env
 * fallback is what lets the production config keep working with no migration
 * step: nothing is stored until an admin saves the form.
 *
 * The store is in memory here; the Postgres one is exercised by
 * tests/integration/transcription-settings.test.ts.
 */

/** A dummy credential, never a real one. */
const KEY = "sk-test-not-a-real-key";

function memoryStore(): TranscriptionStore & {
  hub: HubTranscriptionRecord | null;
  stations: Map<string, StationTranscriptionRecord>;
  reads: number;
} {
  const s = {
    hub: null as HubTranscriptionRecord | null,
    stations: new Map<string, StationTranscriptionRecord>(),
    reads: 0,
    async getHub() {
      s.reads++;
      return s.hub;
    },
    async setHub(rec: HubTranscriptionRecord) {
      s.hub = rec;
    },
    async getStation(id: string) {
      s.reads++;
      return s.stations.get(id) ?? null;
    },
    async setStation(id: string, rec: StationTranscriptionRecord) {
      s.stations.set(id, rec);
    },
  };
  return s;
}

function setup(env: Record<string, string | undefined> = {}, now = () => 0) {
  const store = memoryStore();
  const settings = createTranscriptionSettings({ store, env, now, cipher: { encrypt, decrypt } });
  return { store, settings };
}

const ENV = {
  TRANSCRIBE_URL: "http://env-transcriber:8840",
  TRANSCRIBE_API_KEY: KEY,
  TRANSCRIBE_MODEL: "env-model",
};

describe("resolveFor — precedence", () => {
  test("nothing stored and no env: no transcription", async () => {
    const { settings } = setup();
    expect(await settings.resolveFor("st_1")).toBeNull();
  });

  test("nothing stored: the TRANSCRIBE_* env, so today's production config keeps working", async () => {
    const { settings } = setup(ENV);
    expect(await settings.resolveFor("st_1")).toEqual({
      url: "http://env-transcriber:8840",
      apiKey: KEY,
      model: "env-model",
      maxSeconds: 300,
      source: "env",
    });
  });

  test("the env model defaults to large-v3-turbo", async () => {
    const { settings } = setup({ TRANSCRIBE_URL: "http://t" });
    expect((await settings.resolveFor("st_1"))?.model).toBe("large-v3-turbo");
  });

  test("hub settings beat the env", async () => {
    const { settings } = setup(ENV);
    await settings.putHub({ enabled: true, url: "https://api.groq.com/openai", model: "whisper-large-v3-turbo", maxSeconds: 120, apiKey: KEY });
    expect(await settings.resolveFor("st_1")).toEqual({
      url: "https://api.groq.com/openai",
      apiKey: KEY,
      model: "whisper-large-v3-turbo",
      maxSeconds: 120,
      source: "hub",
    });
  });

  test("hub settings saved as disabled turn it off — they do not fall through to the env", async () => {
    const { settings } = setup(ENV);
    await settings.putHub({ enabled: false, url: "http://t", model: "m", maxSeconds: 300 });
    expect(await settings.resolveFor("st_1")).toBeNull();
  });

  test("a station set to off beats the hub", async () => {
    const { settings } = setup(ENV);
    await settings.putHub({ enabled: true, url: "http://hub", model: "m", maxSeconds: 300 });
    await settings.putStation("st_1", { mode: "off" });
    expect(await settings.resolveFor("st_1")).toBeNull();
    // Only that station.
    expect((await settings.resolveFor("st_2"))?.source).toBe("hub");
  });

  test("a station's custom service beats everything", async () => {
    const { settings } = setup(ENV);
    await settings.putHub({ enabled: true, url: "http://hub", model: "m", maxSeconds: 300 });
    await settings.putStation("st_1", { mode: "custom", url: "https://api.openai.com", model: "whisper-1", maxSeconds: 60, apiKey: KEY });
    expect(await settings.resolveFor("st_1")).toEqual({
      url: "https://api.openai.com",
      apiKey: KEY,
      model: "whisper-1",
      maxSeconds: 60,
      source: "station",
    });
  });

  test("a station set to inherit follows the hub, and the env when the hub has nothing", async () => {
    const { settings } = setup(ENV);
    await settings.putStation("st_1", { mode: "inherit" });
    expect((await settings.resolveFor("st_1"))?.source).toBe("env");
  });
});

describe("keys are write-only and encrypted at rest", () => {
  test("the stored record holds ciphertext, and the view says only that a key exists", async () => {
    const { store, settings } = setup();
    await settings.putHub({ enabled: true, url: "http://hub", model: "m", maxSeconds: 300, apiKey: KEY });

    expect(store.hub?.apiKeyEncrypted).toBeTruthy();
    expect(store.hub?.apiKeyEncrypted).not.toContain(KEY);
    expect(await decrypt(store.hub!.apiKeyEncrypted!)).toBe(KEY);

    const view = await settings.getHubView();
    expect(view).toEqual({ enabled: true, url: "http://hub", model: "m", maxSeconds: 300, hasApiKey: true, source: "settings" });
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(view)).not.toContain(store.hub!.apiKeyEncrypted!);
  });

  test("an omitted key keeps the saved one; null clears it", async () => {
    const { settings } = setup();
    await settings.putHub({ enabled: true, url: "http://hub", model: "m", maxSeconds: 300, apiKey: KEY });
    await settings.putHub({ enabled: true, url: "http://hub2", model: "m", maxSeconds: 300 });
    expect((await settings.resolveFor("st_1"))?.apiKey).toBe(KEY);

    await settings.putHub({ enabled: true, url: "http://hub2", model: "m", maxSeconds: 300, apiKey: null });
    expect((await settings.getHubView()).hasApiKey).toBe(false);
    expect((await settings.resolveFor("st_1"))?.apiKey).toBe("");
  });

  test("the same holds for a station's key, and the station view never carries it", async () => {
    const { store, settings } = setup();
    await settings.putStation("st_1", { mode: "custom", url: "http://s", model: "m", maxSeconds: 300, apiKey: KEY });
    await settings.putStation("st_1", { mode: "custom", url: "http://s2", model: "m", maxSeconds: 300 });
    expect(store.stations.get("st_1")?.apiKeyEncrypted).not.toContain(KEY);

    const view = await settings.getStationView("st_1");
    expect(view.hasApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect((await settings.resolveFor("st_1"))?.apiKey).toBe(KEY);

    await settings.putStation("st_1", { mode: "custom", url: "http://s2", model: "m", maxSeconds: 300, apiKey: null });
    expect((await settings.getStationView("st_1")).hasApiKey).toBe(false);
  });

  test("the env view reports the env config without its key", async () => {
    const { settings } = setup(ENV);
    const view = await settings.getHubView();
    expect(view).toEqual({
      enabled: true,
      url: "http://env-transcriber:8840",
      model: "env-model",
      maxSeconds: 300,
      hasApiKey: true,
      source: "env",
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  test("nothing configured anywhere reads as source none", async () => {
    const { settings } = setup();
    expect(await settings.getHubView()).toEqual({
      enabled: false,
      url: "",
      model: "large-v3-turbo",
      maxSeconds: 300,
      hasApiKey: false,
      source: "none",
    });
  });
});

describe("station view", () => {
  test("a station with no row inherits, and its effective config names where it comes from", async () => {
    const { settings } = setup(ENV);
    expect(await settings.getStationView("st_1")).toEqual({
      mode: "inherit",
      hasApiKey: false,
      effective: { enabled: true, url: "http://env-transcriber:8840", model: "env-model", maxSeconds: 300, source: "env" },
    });
  });

  test("off: effective is disabled, and the custom fields saved earlier survive for next time", async () => {
    const { settings } = setup(ENV);
    await settings.putStation("st_1", { mode: "custom", url: "http://s", model: "m", maxSeconds: 90 });
    await settings.putStation("st_1", { mode: "off" });
    const view = await settings.getStationView("st_1");
    expect(view.mode).toBe("off");
    expect(view.url).toBe("http://s");
    expect(view.maxSeconds).toBe(90);
    expect(view.effective).toEqual({ enabled: false, url: null, model: null, maxSeconds: null, source: "none" });
  });

  test("custom without a url is refused", async () => {
    const { settings } = setup();
    await expect(settings.putStation("st_1", { mode: "custom", model: "m" })).rejects.toThrow(/url/);
  });
});

describe("cache", () => {
  test("a resolution is reused for 30 s, and any save invalidates it", async () => {
    let t = 0;
    const { store, settings } = setup(ENV, () => t);
    await settings.resolveFor("st_1");
    const reads = store.reads;
    await settings.resolveFor("st_1");
    expect(store.reads).toBe(reads);

    t = 31_000;
    await settings.resolveFor("st_1");
    expect(store.reads).toBeGreaterThan(reads);

    await settings.putHub({ enabled: true, url: "http://hub", model: "m", maxSeconds: 300 });
    expect((await settings.resolveFor("st_1"))?.source).toBe("hub");
    await settings.putStation("st_1", { mode: "off" });
    expect(await settings.resolveFor("st_1")).toBeNull();
  });
});
