/**
 * An agent's reply, spoken: a voice message posted after its text.
 *
 * For bridge-mode stations — the hub posts their messages (Claude Code,
 * Codex, opencode, Pi, any ACP-bridged agent). A harness-mode agent is its own
 * Matrix client and speaks for itself (stage 3), so the hub never does.
 *
 * When a turn ends with text in the room (`outbound.ts` calls `speakTurn`,
 * without awaiting it), and the station's speak mode says so:
 *
 *   - `voice_in`: the turn was started by a voice note from the user;
 *   - `always`:   every turn that ended with text;
 *   - `off`:      never;
 *
 * the whole turn's text, as posted, goes to the speech service in the
 * station's voice, and comes back as Ogg/Opus with a duration and (from
 * AgentPod's service) a waveform. It is uploaded as the agent and posted as
 * an MSC3245 voice message.
 *
 * Rules that shape it:
 *
 *   - **Text first, always.** This runs after the text is in the room and
 *     can never delay or replace it.
 *   - **Failure is silent in the room.** A service that is down, slow or
 *     busy is logged once — station, room, reason — and nothing is posted:
 *     no error card, because the answer already arrived as text.
 *   - **Not a reply.** No `m.in_reply_to` to the text: every client that
 *     does not know `dev.agentpod.voice_reply` would quote the whole answer
 *     again above the voice note. `text_event_id` in the key says which
 *     message it speaks.
 *   - **Quiet.** Noted as a quiet hub event, so the push gateway does not
 *     buzz a phone a second time for the same answer.
 *   - **Long replies** are spoken up to `maxChars`, cut at the last sentence
 *     (or paragraph) end before it, with nothing appended: the full text is
 *     right above.
 *   - **Never logged:** the text. Duration, characters, voice and latency are.
 */

import { VOICE_REPLY_CONTENT_KEY, VoiceReply } from "@agentpod/contract";
import { encryptAttachment, type EncryptedFileInfo } from "./attachments";
import type { ResolvedSpeech, SpeakMode } from "../speech-settings";
import type { SpeechEndpoint, SpokenAudio } from "../speech-client";
import { beginQuietSend, noteHubEvent } from "../push/hub-events";

/** What `body` and `filename` say, as Element names its own voice messages. */
export const VOICE_MESSAGE_NAME = "Voice message.ogg";

/** A turn that ended with text in the room. */
export interface SpokenTurn {
  roomId: string;
  agentUser: string;
  sessionId: string;
  /** The whole turn's text, as it was posted. */
  text: string;
  /** The (last) text message the turn posted. */
  textEventId: string;
  /** Whether a voice note from the user started the turn. */
  voiceTriggered: boolean;
}

export type SpeakOutcome =
  | { spoken: true; eventId: string | null; durationMs: number | null; chars: number }
  | {
      spoken: false;
      reason: "not-asked" | "no-service" | "harness-mode" | "no-station" | "empty" | "failed";
      detail?: string;
    };

type Meta = Record<string, unknown>;

export interface VoiceReplyDeps {
  /** The room's station and how it speaks in Matrix. */
  stationFor(roomId: string): Promise<{ stationId: string; identityMode: string } | null>;
  resolveSpeech(stationId: string): Promise<ResolvedSpeech | null>;
  synthesize(endpoint: SpeechEndpoint, request: { text: string; voice: string }): Promise<SpokenAudio>;
  client: {
    uploadMedia(userId: string, bytes: Uint8Array, contentType: string, filename?: string): Promise<string | null>;
    /** Absent: treated as unencrypted (a plaintext bridge sends everything in the clear). */
    isRoomEncrypted?(userId: string, roomId: string): Promise<boolean>;
    sendCustomEvent(
      userId: string,
      roomId: string,
      eventType: string,
      content: Record<string, unknown>
    ): Promise<string | null>;
  };
  log: { info(msg: string, meta?: Meta): void; warn(msg: string, meta?: Meta): void; debug(msg: string, meta?: Meta): void };
  now?: () => number;
}

export function shouldSpeak(mode: SpeakMode, voiceTriggered: boolean): boolean {
  if (mode === "always") return true;
  if (mode === "voice_in") return voiceTriggered;
  return false;
}

/**
 * The part of a reply that is spoken: all of it within `maxChars`, else up to
 * the last sentence end (or paragraph break) inside the limit, else the last
 * whole word. Nothing is appended — the text message holds the rest.
 */
export function textToSpeak(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const window = trimmed.slice(0, maxChars);
  let cut = -1;
  for (const m of window.matchAll(/[.!?…]["'”’)\]]*(?=\s|$)/g)) cut = m.index! + m[0].length;
  const paragraph = window.lastIndexOf("\n\n");
  cut = Math.max(cut, paragraph);
  if (cut < maxChars * 0.3) {
    const space = window.search(/\s\S*$/);
    cut = space > 0 ? space : maxChars;
  }
  return window.slice(0, cut).trim();
}

/** The `m.audio` voice message content. Plain rooms carry `url`; encrypted ones `file`. */
export function voiceReplyContent(input: {
  media: { url: string } | { file: EncryptedFileInfo & { url: string } };
  size: number;
  durationMs: number | null;
  waveform: number[] | null;
  textEventId: string;
  voice: string;
}): Record<string, unknown> {
  const card = VoiceReply.parse({
    schema_version: 1,
    text_event_id: input.textEventId,
    voice: input.voice,
    ...(input.durationMs !== null ? { seconds: Math.min(3600, Math.round(input.durationMs / 1000)) } : {}),
  });
  return {
    msgtype: "m.audio",
    body: VOICE_MESSAGE_NAME,
    filename: VOICE_MESSAGE_NAME,
    ...input.media,
    info: {
      mimetype: "audio/ogg",
      size: input.size,
      ...(input.durationMs !== null ? { duration: input.durationMs } : {}),
    },
    // MSC1767 extensible audio: what Element and Supermessage draw bars from.
    "org.matrix.msc1767.audio": {
      ...(input.durationMs !== null ? { duration: input.durationMs } : {}),
      ...(input.waveform ? { waveform: input.waveform } : {}),
    },
    // MSC3245: "this audio is a voice message", drawn as one rather than a file.
    "org.matrix.msc3245.voice": {},
    [VOICE_REPLY_CONTENT_KEY]: card,
  };
}

export function createVoiceReplier(deps: VoiceReplyDeps) {
  const now = deps.now ?? (() => performance.now());

  async function speakTurn(turn: SpokenTurn): Promise<SpeakOutcome> {
    const started = now();
    const where = { roomId: turn.roomId, sessionId: turn.sessionId };
    let stationId: string | null = null;
    try {
      if (turn.text.trim() === "") return { spoken: false, reason: "empty" };
      const station = await deps.stationFor(turn.roomId);
      if (!station) return { spoken: false, reason: "no-station" };
      stationId = station.stationId;
      if (station.identityMode === "harness") return { spoken: false, reason: "harness-mode" };

      const speech = await deps.resolveSpeech(station.stationId);
      if (!speech) return { spoken: false, reason: "no-service" };
      if (!shouldSpeak(speech.speakMode, turn.voiceTriggered)) return { spoken: false, reason: "not-asked" };

      const text = textToSpeak(turn.text, speech.maxChars);
      if (text === "") return { spoken: false, reason: "empty" };

      const spoken = await deps.synthesize({ url: speech.url, apiKey: speech.apiKey }, { text, voice: speech.voice });
      const synthMs = Math.round(now() - started);

      const encrypted = deps.client.isRoomEncrypted
        ? await deps.client.isRoomEncrypted(turn.agentUser, turn.roomId)
        : false;
      let media: { url: string } | { file: EncryptedFileInfo & { url: string } };
      if (encrypted) {
        const { ciphertext, file } = await encryptAttachment(spoken.audio);
        const mxc = await deps.client.uploadMedia(turn.agentUser, ciphertext, "application/octet-stream", VOICE_MESSAGE_NAME);
        if (!mxc) throw new Error("the homeserver refused the upload");
        media = { file: { ...file, url: mxc } };
      } else {
        const mxc = await deps.client.uploadMedia(turn.agentUser, spoken.audio, spoken.mimeType, VOICE_MESSAGE_NAME);
        if (!mxc) throw new Error("the homeserver refused the upload");
        media = { url: mxc };
      }

      const content = voiceReplyContent({
        media,
        size: spoken.audio.length,
        durationMs: spoken.durationMs,
        waveform: spoken.waveform,
        textEventId: turn.textEventId,
        voice: speech.voice,
      });
      // Quiet: the text already pushed; this must not buzz a second time.
      const end = beginQuietSend(turn.roomId);
      let eventId: string | null;
      try {
        eventId = await deps.client.sendCustomEvent(turn.agentUser, turn.roomId, "m.room.message", content);
        noteHubEvent(eventId, "quiet");
      } finally {
        end();
      }
      deps.log.info("spoke an agent's reply", {
        ...where,
        stationId,
        voice: speech.voice,
        source: speech.source,
        chars: text.length,
        truncated: text.length < turn.text.trim().length,
        durationMs: spoken.durationMs,
        bytes: spoken.audio.length,
        encrypted,
        synthMs,
        latencyMs: Math.round(now() - started),
      });
      return { spoken: true, eventId, durationMs: spoken.durationMs, chars: text.length };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.log.warn("could not speak an agent's reply; the text stands alone", {
        ...where,
        stationId,
        reason,
        latencyMs: Math.round(now() - started),
      });
      return { spoken: false, reason: "failed", detail: reason };
    }
  }

  return { speakTurn };
}

export type VoiceReplier = ReturnType<typeof createVoiceReplier>;
