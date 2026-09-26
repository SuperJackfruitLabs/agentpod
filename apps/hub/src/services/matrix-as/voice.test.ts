import { describe, expect, test } from "bun:test";
import type { EncryptedFile } from "./attachments";
import {
  MAX_VOICE_SECONDS,
  audioSource,
  clock,
  isVoiceRefusal,
  loadVoice,
  openAiTranscriber,
  transcriberFromEnv,
  transcriptContent,
  transcriptNotice,
  voiceNote,
  voicePrompt,
  type Transcriber,
} from "./voice";

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4, 5, 6]);

/** Encrypt the way a Matrix client does, so decryption meets real ciphertext. */
async function encryptLikeAClient(plain: Uint8Array): Promise<{ cipher: Uint8Array; file: EncryptedFile }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-CTR" }, true, ["encrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const iv = new Uint8Array(16);
  iv.set(crypto.getRandomValues(new Uint8Array(8)));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, plain));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", cipher));
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/=+$/, "");
  return {
    cipher,
    file: {
      url: "mxc://id.agentpod.dev/cipher",
      key: { k: jwk.k!, alg: "A256CTR", kty: "oct" },
      iv: b64(iv),
      hashes: { sha256: b64(digest) },
      v: "v2",
    },
  };
}

const heard = (text: string, language: string | null = "en"): Transcriber => ({
  transcribe: async () => ({ text, language }),
});

describe("audioSource", () => {
  test("reads an m.audio voice note: mxc, type, name and length in seconds", () => {
    const src = audioSource({
      msgtype: "m.audio",
      body: "Voice message.m4a",
      url: "mxc://id.agentpod.dev/voice",
      info: { mimetype: "audio/mp4", size: 48_000, duration: 41_600 },
    });
    expect(src?.mxc).toBe("mxc://id.agentpod.dev/voice");
    expect(src?.mimeType).toBe("audio/mp4");
    expect(src?.name).toBe("Voice message.m4a");
    expect(src?.caption).toBe("");
    expect(src?.seconds).toBe(42);
  });

  test("an encrypted room's audio comes from `file`", async () => {
    const { file } = await encryptLikeAClient(AUDIO);
    const src = audioSource({ msgtype: "m.audio", body: "v.ogg", file, info: { mimetype: "audio/ogg" } });
    expect(src?.file).toEqual(file);
    expect(src?.mxc).toBe(file.url);
  });

  test("anything else, or audio with no usable mxc, is not a voice note", () => {
    expect(audioSource({ msgtype: "m.text", body: "hi" })).toBeNull();
    expect(audioSource({ msgtype: "m.image", body: "a.png", url: "mxc://x/y" })).toBeNull();
    expect(audioSource({ msgtype: "m.audio", body: "v.ogg", url: "https://evil.example/v.ogg" })).toBeNull();
    expect(audioSource(undefined)).toBeNull();
  });

  test("a body different from the filename is a caption (MSC2530)", () => {
    const src = audioSource({
      msgtype: "m.audio",
      body: "listen to this",
      filename: "note.ogg",
      url: "mxc://id.agentpod.dev/v",
    });
    expect(src?.caption).toBe("listen to this");
    expect(src?.name).toBe("note.ogg");
  });
});

describe("loadVoice", () => {
  const source = audioSource({
    msgtype: "m.audio",
    body: "v.ogg",
    url: "mxc://id.agentpod.dev/v",
    info: { mimetype: "audio/ogg", duration: 8_000 },
  })!;

  test("fetches, transcribes and returns the words", async () => {
    let asked = "";
    const result = await loadVoice(
      source,
      async (mxc) => {
        asked = mxc;
        return AUDIO;
      },
      heard("the review moved to Thursday")
    );
    expect(asked).toBe("mxc://id.agentpod.dev/v");
    expect(isVoiceRefusal(result)).toBe(false);
    if (!isVoiceRefusal(result)) {
      expect(result.transcript.text).toBe("the review moved to Thursday");
      expect(result.seconds).toBe(8);
    }
  });

  test("decrypts an encrypted room's audio before transcribing it", async () => {
    const { cipher, file } = await encryptLikeAClient(AUDIO);
    const src = audioSource({ msgtype: "m.audio", body: "v.ogg", file, info: { mimetype: "audio/ogg" } })!;
    const got: Uint8Array[] = [];
    await loadVoice(src, async () => cipher, {
      transcribe: async (audio) => {
        got.push(audio);
        return { text: "ok", language: "en" };
      },
    });
    expect(got[0]).toEqual(AUDIO);
  });

  test("over five minutes is refused before anything is downloaded", async () => {
    const long = { ...source, seconds: MAX_VOICE_SECONDS + 1 };
    let downloaded = false;
    const result = await loadVoice(
      long,
      async () => {
        downloaded = true;
        return AUDIO;
      },
      heard("x")
    );
    expect(downloaded).toBe(false);
    expect(isVoiceRefusal(result) && result.reason).toBe("it is longer than 5 minutes");
  });

  test("no transcriber, a failed download, a failed service, or silence each give a reason", async () => {
    expect(await loadVoice(source, async () => AUDIO, null)).toEqual({
      reason: "this hub has no transcription service set up",
    });
    expect(await loadVoice(source, async () => null, heard("x"))).toEqual({ reason: "it could not be downloaded" });
    const failing: Transcriber = { transcribe: async () => { throw new Error("the transcription service answered 503"); } };
    expect(await loadVoice(source, async () => AUDIO, failing)).toEqual({
      reason: "the transcription service answered 503",
    });
    expect(await loadVoice(source, async () => AUDIO, heard("   "))).toEqual({
      reason: "no speech could be heard in it",
    });
  });
});

describe("what the agent and the room are told", () => {
  test("the agent's prompt marks the words as a transcribed voice note, caption first", () => {
    const t = { text: " Kal meeting ke baad report bhej dena. ", language: "hi" };
    expect(voicePrompt(t, 42, "")).toBe("[Voice note, 0:42, transcribed] Kal meeting ke baad report bhej dena.");
    expect(voicePrompt(t, null, "from the car")).toBe(
      "from the car\n[Voice note, transcribed] Kal meeting ke baad report bhej dena."
    );
  });

  test("a voice note that cannot be heard is named with the reason", () => {
    expect(voiceNote("v.ogg", "it is longer than 5 minutes")).toBe(
      "[The user sent a voice note, v.ogg, but it is longer than 5 minutes.]"
    );
  });

  test("the room's notice carries the transcript", () => {
    expect(transcriptNotice({ text: " hello there ", language: "en" })).toBe("Transcript: hello there");
  });

  test("the notice carries the transcript structured, under the namespaced key", () => {
    const content = transcriptContent({ text: " hello there ", language: "en" }, 42);
    expect(content).toEqual({
      "dev.agentpod.voice_transcript": { schema_version: 1, text: "hello there", language: "en", seconds: 42 },
    });
    expect(transcriptContent({ text: "hi", language: null }, null)).toEqual({
      "dev.agentpod.voice_transcript": { schema_version: 1, text: "hi" },
    });
  });

  test("clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(42)).toBe("0:42");
    expect(clock(245)).toBe("4:05");
  });
});

describe("openAiTranscriber", () => {
  test("posts the audio as multipart with the key and model, and reads text and language", async () => {
    let seen: { url: string; auth: string | null; model: unknown; file: File | null } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      seen = {
        url,
        auth: new Headers(init.headers).get("Authorization"),
        model: form.get("model"),
        file: form.get("file") as File | null,
      };
      return new Response(JSON.stringify({ text: "hello", language: "en" }), { status: 200 });
    }) as unknown as typeof fetch;

    const t = openAiTranscriber({ baseUrl: "http://foundry:8840/", apiKey: "k", model: "large-v3-turbo", fetch: fakeFetch });
    expect(await t.transcribe(AUDIO, { mimeType: "audio/ogg", name: "v.ogg" })).toEqual({ text: "hello", language: "en" });
    expect(seen!.url).toBe("http://foundry:8840/v1/audio/transcriptions");
    expect(seen!.auth).toBe("Bearer k");
    expect(seen!.model).toBe("large-v3-turbo");
    expect(seen!.file?.name).toBe("v.ogg");
    expect(new Uint8Array(await seen!.file!.arrayBuffer())).toEqual(AUDIO);
  });

  test("a non-2xx answer is an error naming the status", async () => {
    const fakeFetch = (async () => new Response("too long", { status: 413 })) as unknown as typeof fetch;
    const t = openAiTranscriber({ baseUrl: "http://x", apiKey: "k", model: "m", fetch: fakeFetch });
    await expect(t.transcribe(AUDIO, { mimeType: "", name: "v" })).rejects.toThrow(
      "the transcription service answered 413: too long"
    );
  });

  test("configured only when TRANSCRIBE_URL is set", () => {
    expect(transcriberFromEnv({})).toBeNull();
    expect(transcriberFromEnv({ TRANSCRIBE_URL: "  " })).toBeNull();
    expect(transcriberFromEnv({ TRANSCRIBE_URL: "http://foundry:8840" })).not.toBeNull();
  });
});
