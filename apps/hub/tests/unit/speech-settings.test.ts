import { describe, expect, test } from "bun:test";
import {
  assignedVoiceFor,
  CURATED_VOICES,
  createSpeechSettings,
  DEFAULT_MAX_CHARS,
  type HubSpeechRecord,
  type SpeechStore,
  type StationSpeechRecord,
} from "../../src/services/speech-settings";
import { encrypt, decrypt } from "../../src/utils/encryption";

/**
 * Where an agent's spoken replies come from, and in which voice.
 *
 * The service: the station's own custom service, then the station saying
 * "off", then the hub-wide settings an admin saved, then the SPEECH_* env,
 * then nothing — transcription's precedence, copied. The voice and whether
 * to speak at all are overridable per station without overriding the
 * service. A station with no voice gets one derived from its id, so two
 * agents in the fleet do not sound the same by default.
 *
 * In memory here; the Postgres store is in tests/integration/speech-settings.test.ts.
 */

/** A dummy credential, never a real one. */
const KEY = "sk-test-not-a-real-key";

function memoryStore(): SpeechStore & {
  hub: HubSpeechRecord | null;
  stations: Map<string, StationSpeechRecord>;
  reads: number;
} {
  const s = {
    hub: null as HubSpeechRecord | null,
    stations: new Map<string, StationSpeechRecord>(),
    reads: 0,
    async getHub() {
      s.reads++;
      return s.hub;
    },
    async setHub(rec: HubSpeechRecord) {
      s.hub = rec;
    },
    async getStation(id: string) {
      s.reads++;
      return s.stations.get(id) ?? null;
    },
    async setStation(id: string, rec: StationSpeechRecord) {
      s.stations.set(id, rec);
    },
  };
  return s;
}

function setup(env: Record<string, string | undefined> = {}, now = () => 0) {
  const store = memoryStore();
  const settings = createSpeechSettings({ store, env, now, cipher: { encrypt, decrypt } });
  return { store, settings };
}

const ENV = { SPEECH_URL: "http://env-speech:8841", SPEECH_API_KEY: KEY };

const hubOn = { enabled: true, url: "http://hub-speech:8841", defaultVoice: "", mode: "always" as const, maxChars: 900 };

describe("assignedVoiceFor — a distinct default voice per agent", () => {
  test("stable: the same station always gets the same voice", () => {
    for (const id of ["st_1", "st_abc", "3f1c7a4e-0000-4000-8000-000000000001"]) {
      expect(assignedVoiceFor(id)).toBe(assignedVoiceFor(id));
      expect(CURATED_VOICES).toContain(assignedVoiceFor(id));
    }
  });

  test("pinned values, so a change to the hash is a visible change to every agent's voice", () => {
    expect(assignedVoiceFor("st_1")).toBe(assignedVoiceFor("st_1"));
    const pinned = ["st_1", "st_2", "st_3"].map(assignedVoiceFor);
    // Recomputed by hand from FNV-1a 32 over the UTF-8 id, mod 15.
    expect(pinned).toEqual(["am_puck", "af_aoede", "af_kore"]);
  });

  test("spread: 200 stations use most of the list and no voice takes a quarter", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const v = assignedVoiceFor(`st_${crypto.randomUUID()}`);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect(counts.size).toBeGreaterThanOrEqual(12);
    expect(Math.max(...counts.values())).toBeLessThan(50);
  });

  test("the curated list is the fifteen good voices", () => {
    expect(CURATED_VOICES).toHaveLength(15);
    expect(new Set(CURATED_VOICES).size).toBe(15);
    expect(CURATED_VOICES[0]).toBe("af_heart");
  });
});

describe("resolveFor — the service", () => {
  test("nothing stored and no env: no speech", async () => {
    const { settings } = setup();
    expect(await settings.resolveFor("st_1")).toBeNull();
  });

  test("nothing stored: the SPEECH_* env, speaking replies to voice notes by default", async () => {
    const { settings } = setup(ENV);
    expect(await settings.resolveFor("st_1")).toEqual({
      url: "http://env-speech:8841",
      apiKey: KEY,
      voice: assignedVoiceFor("st_1"),
      voiceSource: "assigned",
      speakMode: "voice_in",
      maxChars: DEFAULT_MAX_CHARS,
      source: "env",
    });
  });

  test("SPEECH_VOICE and SPEECH_MODE are read from the env", async () => {
    const { settings } = setup({ ...ENV, SPEECH_VOICE: "bf_emma", SPEECH_MODE: "always" });
    const r = await settings.resolveFor("st_1");
    expect(r?.voice).toBe("bf_emma");
    expect(r?.voiceSource).toBe("hub");
    expect(r?.speakMode).toBe("always");
  });

  test("an unknown SPEECH_MODE is the default, not a crash", async () => {
    const { settings } = setup({ ...ENV, SPEECH_MODE: "loud" });
    expect((await settings.resolveFor("st_1"))?.speakMode).toBe("voice_in");
  });

  test("saved hub settings beat the env", async () => {
    const { settings } = setup(ENV);
    await settings.putHub({ ...hubOn, apiKey: "hub-key" });
    expect(await settings.resolveFor("st_1")).toMatchObject({
      url: "http://hub-speech:8841",
      apiKey: "hub-key",
      speakMode: "always",
      maxChars: 900,
      source: "hub",
    });
  });

  test("a saved but disabled hub setting is an answer, not an absence: no fall-through to env", async () => {
    const { settings } = setup(ENV);
    await settings.putHub({ ...hubOn, enabled: false });
    expect(await settings.resolveFor("st_1")).toBeNull();
  });

  test("station off beats everything", async () => {
    const { settings } = setup(ENV);
    await settings.putStation("st_1", { mode: "off" });
    expect(await settings.resolveFor("st_1")).toBeNull();
    expect(await settings.resolveFor("st_2")).not.toBeNull();
  });

  test("station custom beats the hub", async () => {
    const { settings } = setup(ENV);
    await settings.putStation("st_1", { mode: "custom", url: "http://mine:9000", apiKey: "mine" });
    expect(await settings.resolveFor("st_1")).toMatchObject({
      url: "http://mine:9000",
      apiKey: "mine",
      source: "station",
    });
  });

  test("voice and speak mode are overridable without overriding the service", async () => {
    const { settings } = setup(ENV);
    await settings.putStation("st_1", { mode: "inherit", voice: "bm_george", speakMode: "always" });
    expect(await settings.resolveFor("st_1")).toMatchObject({
      url: "http://env-speech:8841",
      source: "env",
      voice: "bm_george",
      voiceSource: "station",
      speakMode: "always",
    });
  });

  test("voice precedence: station > hub default > assigned", async () => {
    const { settings } = setup(ENV);
    await settings.putHub({ ...hubOn, defaultVoice: "af_bella" });
    expect((await settings.resolveFor("st_2"))?.voice).toBe("af_bella");
    await settings.putStation("st_2", { mode: "inherit", voice: "af_nova" });
    expect((await settings.resolveFor("st_2"))?.voice).toBe("af_nova");
    // The view still says what "no voice" would fall back to.
    expect(await settings.getStationView("st_2")).toMatchObject({
      voice: "af_nova",
      inheritedVoice: "af_bella",
      inheritedVoiceSource: "hub",
    });
    await settings.putHub({ ...hubOn, defaultVoice: "" });
    expect((await settings.resolveFor("st_3"))?.voice).toBe(assignedVoiceFor("st_3"));
  });

  test("station speakMode off keeps the service but says do not speak", async () => {
    const { settings } = setup(ENV);
    await settings.putStation("st_1", { mode: "inherit", speakMode: "off" });
    expect((await settings.resolveFor("st_1"))?.speakMode).toBe("off");
  });

  test("answers are cached for 30 s and a save clears the cache", async () => {
    let t = 0;
    const { settings, store } = setup(ENV, () => t);
    await settings.resolveFor("st_1");
    const reads = store.reads;
    await settings.resolveFor("st_1");
    expect(store.reads).toBe(reads);
    t = 31_000;
    await settings.resolveFor("st_1");
    expect(store.reads).toBeGreaterThan(reads);
    await settings.putStation("st_1", { mode: "off" });
    expect(await settings.resolveFor("st_1")).toBeNull();
  });
});

describe("keys — encrypted at rest, never returned", () => {
  test("the stored key is ciphertext and the view says only hasApiKey", async () => {
    const { settings, store } = setup();
    const view = await settings.putHub({ ...hubOn, apiKey: KEY });
    expect(store.hub?.apiKeyEncrypted).toBeTruthy();
    expect(store.hub?.apiKeyEncrypted).not.toContain(KEY);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.hasApiKey).toBe(true);
  });

  test("an omitted key keeps the saved one; null clears it", async () => {
    const { settings } = setup();
    await settings.putHub({ ...hubOn, apiKey: KEY });
    await settings.putHub({ ...hubOn, url: "http://moved:8841" });
    expect((await settings.resolveFor("st_1"))?.apiKey).toBe(KEY);
    const cleared = await settings.putHub({ ...hubOn, apiKey: null });
    expect(cleared.hasApiKey).toBe(false);
    expect((await settings.resolveFor("st_1"))?.apiKey).toBe("");
  });

  test("the env view reports a key without showing it", async () => {
    const { settings } = setup(ENV);
    const view = await settings.getHubView();
    expect(view).toMatchObject({ source: "env", url: ENV.SPEECH_URL, hasApiKey: true, enabled: true });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  test("a station's custom key is never in its view", async () => {
    const { settings } = setup();
    const view = await settings.putStation("st_1", { mode: "custom", url: "http://mine:9000", apiKey: KEY });
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.hasApiKey).toBe(true);
  });
});

describe("views", () => {
  test("nothing configured: the hub view is off, and the station still has its assigned voice", async () => {
    const { settings } = setup();
    expect(await settings.getHubView()).toMatchObject({ enabled: false, source: "none", hasApiKey: false });
    const view = await settings.getStationView("st_1");
    expect(view.mode).toBe("inherit");
    expect(view.assignedVoice).toBe(assignedVoiceFor("st_1"));
    expect(view.effective).toMatchObject({
      enabled: false,
      voice: assignedVoiceFor("st_1"),
      voiceSource: "assigned",
      source: "none",
    });
  });

  test("fields not sent keep what was saved: switching to off and back needs no retyping", async () => {
    const { settings } = setup();
    await settings.putStation("st_1", { mode: "custom", url: "http://mine:9000", voice: "bf_emma", speakMode: "always" });
    await settings.putStation("st_1", { mode: "off" });
    const back = await settings.putStation("st_1", { mode: "custom" });
    expect(back).toMatchObject({ mode: "custom", url: "http://mine:9000", voice: "bf_emma", speakMode: "always" });
  });

  test("null clears a station's voice and speak mode back to inherited", async () => {
    const { settings } = setup(ENV);
    await settings.putStation("st_1", { mode: "inherit", voice: "bf_emma", speakMode: "always" });
    const view = await settings.putStation("st_1", { mode: "inherit", voice: null, speakMode: null });
    expect(view.voice).toBeUndefined();
    expect(view.speakMode).toBeUndefined();
    expect(view.effective.voiceSource).toBe("assigned");
    expect(view.effective.speakMode).toBe("voice_in");
  });

  test("custom with no url, sent or saved, is refused", async () => {
    const { settings } = setup();
    await expect(settings.putStation("st_1", { mode: "custom" })).rejects.toThrow(/url/);
  });

  test("enabling the hub with no url is refused", async () => {
    const { settings } = setup();
    await expect(settings.putHub({ ...hubOn, url: "" })).rejects.toThrow(/url/);
  });
});

describe("hubEndpoint — what the voices proxy and the test use", () => {
  test("the saved hub service, else the env, else none", async () => {
    const empty = setup();
    expect(await empty.settings.hubEndpoint()).toBeNull();
    const env = setup(ENV);
    expect(await env.settings.hubEndpoint()).toEqual({ url: ENV.SPEECH_URL, apiKey: KEY });
    await env.settings.putHub({ ...hubOn, apiKey: "hub-key" });
    expect(await env.settings.hubEndpoint()).toEqual({ url: hubOn.url, apiKey: "hub-key" });
  });

  test("the test endpoint takes typed overrides and keeps the saved key when none is typed", async () => {
    const { settings } = setup();
    await settings.putHub({ ...hubOn, apiKey: KEY });
    expect(await settings.endpointForTest({ url: "http://new:8841" })).toEqual({ url: "http://new:8841", apiKey: KEY });
    expect(await settings.endpointForTest({ apiKey: "typed" })).toEqual({ url: hubOn.url, apiKey: "typed" });
  });
});
