import { describe, expect, test } from "bun:test";
import { VOICE_REPLY_CONTENT_KEY, VoiceReply } from "@agentpod/contract";
import {
  createVoiceReplier,
  shouldSpeak,
  textToSpeak,
  voiceReplyContent,
  type SpokenTurn,
  type VoiceReplyDeps,
} from "./voice-reply";
import { decryptAttachment } from "./attachments";
import type { ResolvedSpeech } from "../speech-settings";
import { SpeechHttpError } from "../speech-client";

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 8, 7, 6, 5]);

const SPEECH: ResolvedSpeech = {
  url: "http://speech.test:8841",
  apiKey: "sk-test-not-a-real-key",
  voice: "bf_emma",
  voiceSource: "assigned",
  speakMode: "voice_in",
  maxChars: 1500,
  source: "env",
};

const TURN: SpokenTurn = {
  roomId: "!room:id.agentpod.dev",
  agentUser: "@agent_n__s:id.agentpod.dev",
  sessionId: "sess-1",
  text: "The build is green. I pushed the fix.",
  textEventId: "$text1",
  voiceTriggered: true,
};

function harness(opts: {
  speech?: ResolvedSpeech | null;
  encrypted?: boolean;
  identityMode?: string;
  synth?: VoiceReplyDeps["synthesize"];
  upload?: (bytes: Uint8Array, type: string) => Promise<string | null>;
} = {}) {
  const sent: Array<{ userId: string; roomId: string; type: string; content: Record<string, unknown> }> = [];
  const uploads: Array<{ userId: string; bytes: Uint8Array; type: string; filename?: string }> = [];
  const synthCalls: Array<{ url: string; text: string; voice: string }> = [];
  const logs: Array<{ msg: string; meta: Record<string, unknown> }> = [];
  const deps: VoiceReplyDeps = {
    stationFor: async () => ({ stationId: "st_1", identityMode: opts.identityMode ?? "bridge" }),
    resolveSpeech: async () => (opts.speech === undefined ? SPEECH : opts.speech),
    synthesize:
      opts.synth ??
      (async (endpoint, req) => {
        synthCalls.push({ url: endpoint.url, text: req.text, voice: req.voice });
        return { audio: OGG, mimeType: "audio/ogg", durationMs: 4210, waveform: [0, 512, 1024] };
      }),
    client: {
      async uploadMedia(userId, bytes, type, filename) {
        uploads.push({ userId, bytes, type, filename });
        return opts.upload ? opts.upload(bytes, type) : "mxc://id.agentpod.dev/voice1";
      },
      async isRoomEncrypted() {
        return opts.encrypted ?? false;
      },
      async sendCustomEvent(userId, roomId, type, content) {
        sent.push({ userId, roomId, type, content });
        return "$voice1";
      },
    },
    log: {
      info: (msg, meta) => logs.push({ msg, meta: meta ?? {} }),
      warn: (msg, meta) => logs.push({ msg, meta: meta ?? {} }),
      debug: () => {},
    },
  };
  return { replier: createVoiceReplier(deps), sent, uploads, synthCalls, logs };
}

describe("shouldSpeak", () => {
  test("voice_in speaks only a turn a voice note started; always speaks every turn; off never", () => {
    expect(shouldSpeak("voice_in", true)).toBe(true);
    expect(shouldSpeak("voice_in", false)).toBe(false);
    expect(shouldSpeak("always", false)).toBe(true);
    expect(shouldSpeak("always", true)).toBe(true);
    expect(shouldSpeak("off", true)).toBe(false);
  });
});

describe("textToSpeak — the part of a long reply that is spoken", () => {
  test("a reply within the limit is spoken whole", () => {
    expect(textToSpeak("One. Two.", 100)).toBe("One. Two.");
  });

  test("a long reply is cut at the last sentence end within the limit, and nothing is added", () => {
    const text = "First sentence here. Second one is here too. Third goes past the limit for sure.";
    expect(textToSpeak(text, 50)).toBe("First sentence here. Second one is here too.");
  });

  test("a paragraph break counts as a boundary", () => {
    expect(textToSpeak("A list:\n\n- one item that is long enough to go past", 20)).toBe("A list:");
  });

  test("no sentence end in reach: the last whole word", () => {
    expect(textToSpeak("averyveryverylongword another word", 30)).toBe("averyveryverylongword another");
  });
});

describe("voiceReplyContent — the Matrix event", () => {
  test("a plain room: url, MSC3245 voice, MSC1767 audio with waveform, and the voice_reply key", () => {
    const content = voiceReplyContent({
      media: { url: "mxc://id.agentpod.dev/voice1" },
      size: 9,
      durationMs: 4210,
      waveform: [0, 512, 1024],
      textEventId: "$text1",
      voice: "bf_emma",
    });
    expect(content).toEqual({
      msgtype: "m.audio",
      body: "Voice message.ogg",
      filename: "Voice message.ogg",
      url: "mxc://id.agentpod.dev/voice1",
      info: { mimetype: "audio/ogg", size: 9, duration: 4210 },
      "org.matrix.msc1767.audio": { duration: 4210, waveform: [0, 512, 1024] },
      "org.matrix.msc3245.voice": {},
      [VOICE_REPLY_CONTENT_KEY]: { schema_version: 1, text_event_id: "$text1", voice: "bf_emma", seconds: 4 },
    });
    // Not a reply: other clients would quote the text a second time.
    expect(content["m.relates_to"]).toBeUndefined();
    expect(VoiceReply.parse(content[VOICE_REPLY_CONTENT_KEY])).toBeTruthy();
  });

  test("no duration or waveform from the service: those fields are left out, not invented", () => {
    const content = voiceReplyContent({
      media: { url: "mxc://x/y" },
      size: 9,
      durationMs: null,
      waveform: null,
      textEventId: "$t",
      voice: "af_heart",
    });
    expect(content.info).toEqual({ mimetype: "audio/ogg", size: 9 });
    expect(content["org.matrix.msc1767.audio"]).toEqual({});
    expect(content[VOICE_REPLY_CONTENT_KEY]).toEqual({ schema_version: 1, text_event_id: "$t", voice: "af_heart" });
  });
});

describe("speakTurn", () => {
  test("voice_in after a voice note: synthesised in the station's voice, uploaded as the agent, posted as a voice message", async () => {
    const h = harness();
    const out = await h.replier.speakTurn(TURN);
    expect(out).toMatchObject({ spoken: true, eventId: "$voice1" });
    expect(h.synthCalls).toEqual([{ url: SPEECH.url, text: TURN.text, voice: "bf_emma" }]);
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0]).toMatchObject({ userId: TURN.agentUser, type: "audio/ogg", filename: "Voice message.ogg" });
    expect(h.uploads[0]!.bytes).toEqual(OGG);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.type).toBe("m.room.message");
    expect(h.sent[0]!.userId).toBe(TURN.agentUser);
    expect(h.sent[0]!.content).toMatchObject({
      msgtype: "m.audio",
      url: "mxc://id.agentpod.dev/voice1",
      "org.matrix.msc3245.voice": {},
      [VOICE_REPLY_CONTENT_KEY]: { text_event_id: "$text1", voice: "bf_emma" },
    });
  });

  test("voice_in after a typed message: nothing is synthesised", async () => {
    const h = harness();
    expect(await h.replier.speakTurn({ ...TURN, voiceTriggered: false })).toEqual({ spoken: false, reason: "not-asked" });
    expect(h.synthCalls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  test("always: a typed turn is spoken too", async () => {
    const h = harness({ speech: { ...SPEECH, speakMode: "always" } });
    expect((await h.replier.speakTurn({ ...TURN, voiceTriggered: false })).spoken).toBe(true);
  });

  test("off: never", async () => {
    const h = harness({ speech: { ...SPEECH, speakMode: "off" } });
    expect((await h.replier.speakTurn(TURN)).spoken).toBe(false);
    expect(h.synthCalls).toHaveLength(0);
  });

  test("no speech service: nothing", async () => {
    const h = harness({ speech: null });
    expect(await h.replier.speakTurn(TURN)).toEqual({ spoken: false, reason: "no-service" });
  });

  test("a harness-mode station speaks for itself: the hub does not", async () => {
    const h = harness({ identityMode: "harness" });
    expect(await h.replier.speakTurn(TURN)).toEqual({ spoken: false, reason: "harness-mode" });
    expect(h.synthCalls).toHaveLength(0);
  });

  test("an empty reply is not spoken", async () => {
    const h = harness();
    expect((await h.replier.speakTurn({ ...TURN, text: "  \n " })).spoken).toBe(false);
    expect(h.synthCalls).toHaveLength(0);
  });

  test("a reply past maxChars is cut at a sentence", async () => {
    const h = harness({ speech: { ...SPEECH, maxChars: 20 } });
    await h.replier.speakTurn(TURN);
    expect(h.synthCalls[0]!.text).toBe("The build is green.");
  });

  describe("a turn that is not spoken says why, once, in the log", () => {
    /** The skip lines the replier wrote. */
    const skips = (h: ReturnType<typeof harness>) => h.logs.filter((l) => l.msg === "did not speak an agent's reply");

    const cases: Array<[string, Parameters<typeof harness>[0], Partial<SpokenTurn>, string]> = [
      ["speak mode off", { speech: { ...SPEECH, speakMode: "off" } }, {}, "speak_mode_off"],
      ["voice_in, a typed turn", {}, { voiceTriggered: false }, "not_voice_turn"],
      ["no speech service", { speech: null }, {}, "no_service"],
      ["a harness-mode station", { identityMode: "harness" }, {}, "harness_mode"],
      ["nothing to say", {}, { text: "  \n " }, "empty_text"],
      ["an error turn", {}, { errorTurn: true }, "error_turn"],
    ];
    for (const [name, opts, turn, reason] of cases) {
      test(`${name}: ${reason}`, async () => {
        const h = harness(opts);
        expect((await h.replier.speakTurn({ ...TURN, ...turn })).spoken).toBe(false);
        expect(skips(h)).toEqual([
          {
            msg: "did not speak an agent's reply",
            meta: { reason, stationId: "st_1", roomId: TURN.roomId, sessionId: TURN.sessionId },
          },
        ]);
        expect(h.synthCalls).toHaveLength(0);
        expect(JSON.stringify(h.logs)).not.toContain(TURN.text);
      });
    }

    test("an error turn is not synthesised even when every turn is spoken", async () => {
      const h = harness({ speech: { ...SPEECH, speakMode: "always" } });
      expect(await h.replier.speakTurn({ ...TURN, errorTurn: true })).toEqual({ spoken: false, reason: "error-turn" });
      expect(h.synthCalls).toHaveLength(0);
    });

    test("a spoken turn writes no skip line", async () => {
      const h = harness();
      expect((await h.replier.speakTurn(TURN)).spoken).toBe(true);
      expect(skips(h)).toEqual([]);
    });
  });

  test("the service failing posts nothing, never throws, and logs once without the text", async () => {
    const h = harness({
      synth: async () => {
        throw new SpeechHttpError(503, "busy");
      },
    });
    const out = await h.replier.speakTurn(TURN);
    expect(out.spoken).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
    const warns = h.logs.filter((l) => l.msg.includes("could not speak"));
    expect(warns).toHaveLength(1);
    expect(warns[0]!.meta).toMatchObject({ stationId: "st_1", roomId: TURN.roomId });
    expect(String(warns[0]!.meta.reason)).toContain("503");
    expect(JSON.stringify(h.logs)).not.toContain(TURN.text);
  });

  test("an upload the homeserver refuses posts nothing", async () => {
    const h = harness({ upload: async () => null });
    expect((await h.replier.speakTurn(TURN)).spoken).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  test("a spoken reply is logged with duration, chars, voice and latency, never the text", async () => {
    const h = harness();
    await h.replier.speakTurn(TURN);
    const spoke = h.logs.find((l) => l.msg.includes("spoke"));
    expect(spoke?.meta).toMatchObject({ stationId: "st_1", voice: "bf_emma", chars: TURN.text.length, durationMs: 4210 });
    expect(typeof spoke?.meta.latencyMs).toBe("number");
    expect(JSON.stringify(h.logs)).not.toContain(TURN.text);
  });

  test("an encrypted room: the audio is encrypted, uploaded as ciphertext, and sent as `file`, not `url`", async () => {
    const h = harness({ encrypted: true });
    const out = await h.replier.speakTurn(TURN);
    expect(out.spoken).toBe(true);
    expect(h.uploads[0]!.type).toBe("application/octet-stream");
    expect(h.uploads[0]!.bytes).not.toEqual(OGG);
    const content = h.sent[0]!.content as Record<string, any>;
    expect(content.url).toBeUndefined();
    expect(content.file).toMatchObject({ url: "mxc://id.agentpod.dev/voice1", v: "v2" });
    expect(content.info).toMatchObject({ mimetype: "audio/ogg", size: OGG.length });
    // What a reader's client does: fetch the ciphertext, decrypt with `file`.
    const plain = await decryptAttachment(h.uploads[0]!.bytes, content.file);
    expect(plain).toEqual(OGG);
  });
});
