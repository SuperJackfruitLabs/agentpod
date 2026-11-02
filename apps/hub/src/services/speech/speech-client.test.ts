import { describe, expect, test } from "bun:test";
import { fetchVoices, parseWaveform, SpeechHttpError, synthesize, testSpeech } from "./speech-client";

/** A dummy credential, never a real one. */
const KEY = "sk-test-not-a-real-key";
const ENDPOINT = { url: "http://speech.test:8841/", apiKey: KEY };
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);

function recordingFetch(respond: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("synthesize", () => {
  test("asks for Ogg/Opus with a waveform, in the voice, with the token; reads duration and waveform", async () => {
    const { f, calls } = recordingFetch(
      () =>
        new Response(OGG, {
          headers: { "content-type": "audio/ogg", "x-audio-duration-ms": "4210", "x-audio-waveform": "0,512,1024" },
        })
    );
    const out = await synthesize(ENDPOINT, { text: "Hello there.", voice: "bf_emma" }, { fetch: f });
    expect(calls[0]!.url).toBe("http://speech.test:8841/v1/audio/speech");
    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect((init.headers as Record<string, string>)["X-Want-Waveform"]).toBe("1");
    expect(JSON.parse(String(init.body))).toMatchObject({
      input: "Hello there.",
      voice: "bf_emma",
      response_format: "opus",
      waveform: true,
    });
    expect(out.audio).toEqual(OGG);
    expect(out.durationMs).toBe(4210);
    expect(out.waveform).toEqual([0, 512, 1024]);
  });

  test("a service without the waveform header still speaks: waveform null", async () => {
    const { f } = recordingFetch(() => new Response(OGG, { headers: { "x-audio-duration-ms": "900" } }));
    const out = await synthesize(ENDPOINT, { text: "Hi.", voice: "af_heart" }, { fetch: f });
    expect(out.waveform).toBeNull();
    expect(out.durationMs).toBe(900);
  });

  test("a non-2xx is a SpeechHttpError naming the status", async () => {
    const { f } = recordingFetch(() => new Response('{"detail":"busy"}', { status: 503 }));
    const err = await synthesize(ENDPOINT, { text: "Hi.", voice: "af_heart" }, { fetch: f }).catch((e) => e);
    expect(err).toBeInstanceOf(SpeechHttpError);
    expect(err.status).toBe(503);
  });
});

describe("parseWaveform", () => {
  test("clamps to 0..1024, drops junk, and refuses what is not a waveform", () => {
    expect(parseWaveform("1,2000,-5,7")).toEqual([1, 1024, 0, 7]);
    expect(parseWaveform(null)).toBeNull();
    expect(parseWaveform("")).toBeNull();
    expect(parseWaveform("a,b")).toBeNull();
    expect(parseWaveform(Array(300).fill("5").join(","))).toHaveLength(256);
  });
});

describe("testSpeech", () => {
  test("ok: status, elapsed, duration, and the clip for the console to play", async () => {
    const { f } = recordingFetch(() => new Response(OGG, { headers: { "x-audio-duration-ms": "2100" } }));
    let t = 0;
    const r = await testSpeech(ENDPOINT, { fetch: f, now: () => (t += 50) });
    expect(r).toMatchObject({ ok: true, status: 200, elapsedMs: 50, durationMs: 2100 });
    expect(r.audio).toBe(Buffer.from(OGG).toString("base64"));
  });

  test("a refusal reports the status and never the key", async () => {
    const { f } = recordingFetch(() => new Response('{"detail":"unauthorized"}', { status: 401 }));
    const r = await testSpeech(ENDPOINT, { fetch: f });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  test("an unreachable service is not ok and has no status", async () => {
    const f = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await testSpeech(ENDPOINT, { fetch: f });
    expect(r.ok).toBe(false);
    expect(r.status).toBeUndefined();
    expect(r.error).toContain("ECONNREFUSED");
  });
});

describe("fetchVoices", () => {
  test("GETs /v1/voices with the token", async () => {
    const body = { voices: [{ id: "af_heart" }], default: "af_heart", aliases: {} };
    const { f, calls } = recordingFetch(() => Response.json(body));
    expect(await fetchVoices(ENDPOINT, { fetch: f })).toEqual(body);
    expect(calls[0]!.url).toBe("http://speech.test:8841/v1/voices");
  });
});
