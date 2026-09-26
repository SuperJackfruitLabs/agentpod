/**
 * Voice notes sent into a bridged room, made into words an agent can read.
 *
 * No ACP adapter AgentPod runs accepts audio, so a voice note reached the
 * agent as its file name and nothing else (2026-09-24). Here: find the audio
 * in the event, fetch it as the agent, decrypt it when the room is encrypted,
 * and send it to a speech-to-text service. The transcript goes to the agent
 * as the message, and into the room under the voice note so the sender can
 * see what the agent heard.
 *
 * The service is anything that speaks OpenAI's `/v1/audio/transcriptions`:
 * AgentPod's own transcriber (`deploy/transcriber`, faster-whisper on
 * foundry), or a hosted provider. Unset, voice notes are named to the agent
 * as before. Pure apart from the injected download and fetch.
 */

import { VOICE_TRANSCRIPT_CONTENT_KEY, type VoiceTranscript } from "@agentpod/contract";
import { decryptAttachment, parseMxc, type EncryptedFile } from "./attachments";

/**
 * The longest voice note transcribed by default. Longer ones are named, not
 * heard. A hub or station setting can move it (`transcription-settings.ts`).
 */
export const MAX_VOICE_SECONDS = 300;

/**
 * The biggest audio file fetched, before decryption. Five minutes of voice is
 * a few megabytes in any codec a phone records; this only stops a mislabelled
 * video or a lossless recording from being pulled whole.
 */
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;

/** A voice note an event refers to. */
export interface AudioSource {
  mxc: string;
  file: EncryptedFile | null;
  mimeType: string;
  name: string;
  /** What the sender wrote with it, or "" — MSC2530, as for images. */
  caption: string;
  size: number | null;
  /** Length in seconds, when the client said. */
  seconds: number | null;
}

/** What a transcription service returned. */
export interface Transcript {
  text: string;
  /** The language it heard, as an ISO code, when it said. */
  language: string | null;
}

export interface Transcriber {
  transcribe(audio: Uint8Array, meta: { mimeType: string; name: string }): Promise<Transcript>;
}

/** A voice note turned into words, or the reason it could not be. */
export type VoiceResult =
  | { transcript: Transcript; seconds: number | null }
  | { reason: string };

/**
 * The audio an `m.audio` message carries, or null for any other message.
 *
 * `info.duration` is milliseconds, per the spec. The caption rule is the one
 * `imageSource` uses: `body` is a caption only when it differs from
 * `filename`.
 */
export function audioSource(content: Record<string, unknown> | undefined): AudioSource | null {
  if (!content || content.msgtype !== "m.audio") return null;

  const file = asEncryptedFile(content.file);
  const mxc = file?.url ?? (typeof content.url === "string" ? content.url : null);
  if (!mxc || !parseMxc(mxc)) return null;

  const info = (content.info ?? {}) as Record<string, unknown>;
  const body = typeof content.body === "string" ? content.body : "";
  const filename = typeof content.filename === "string" ? content.filename : null;
  const caption = filename !== null && body !== filename ? body : "";
  const duration = typeof info.duration === "number" && info.duration > 0 ? info.duration : null;

  return {
    mxc,
    file,
    mimeType: typeof info.mimetype === "string" ? info.mimetype : "",
    name: filename ?? (body || "voice note"),
    caption,
    size: typeof info.size === "number" ? info.size : null,
    seconds: duration === null ? null : Math.round(duration / 1000),
  };
}

function asEncryptedFile(value: unknown): EncryptedFile | null {
  if (!value || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  const key = f.key as Record<string, unknown> | undefined;
  if (typeof f.url !== "string" || typeof f.iv !== "string" || !key || typeof key.k !== "string" || !f.hashes) {
    return null;
  }
  return f as unknown as EncryptedFile;
}

/**
 * Fetch, decrypt and transcribe one voice note.
 *
 * Never throws: a voice note that cannot be heard still reaches the agent, as
 * a note saying why, and the room is told the same.
 */
export async function loadVoice(
  source: AudioSource,
  download: (mxc: string) => Promise<Uint8Array | null>,
  transcriber: Transcriber | null,
  maxSeconds: number = MAX_VOICE_SECONDS
): Promise<VoiceResult> {
  if (!transcriber) return { reason: "this hub has no transcription service set up" };
  if (source.seconds !== null && source.seconds > maxSeconds) {
    return { reason: `it is longer than ${duration(maxSeconds)}` };
  }
  if (source.size !== null && source.size > MAX_VOICE_BYTES) {
    return { reason: `it is larger than ${MAX_VOICE_BYTES / (1024 * 1024)} MB` };
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await download(source.mxc);
  } catch {
    bytes = null;
  }
  if (!bytes) return { reason: "it could not be downloaded" };
  if (source.file) {
    try {
      bytes = await decryptAttachment(bytes, source.file);
    } catch (err) {
      return { reason: err instanceof Error ? err.message : "it could not be decrypted" };
    }
  }
  if (bytes.length > MAX_VOICE_BYTES) {
    return { reason: `it is larger than ${MAX_VOICE_BYTES / (1024 * 1024)} MB` };
  }

  try {
    const transcript = await transcriber.transcribe(bytes, { mimeType: source.mimeType, name: source.name });
    if (transcript.text.trim() === "") return { reason: "no speech could be heard in it" };
    return { transcript, seconds: source.seconds };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : "it could not be transcribed" };
  }
}

/** `5 minutes`, `90 seconds` — whichever is exact. */
function duration(seconds: number): string {
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return m === 1 ? "1 minute" : `${m} minutes`;
  }
  return `${seconds} seconds`;
}

export function isVoiceRefusal(value: VoiceResult): value is { reason: string } {
  return "reason" in value;
}

/** `0:42`, `4:05`. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * What the agent reads for a transcribed voice note: marked as speech, so it
 * knows the words were spoken and may carry a transcription's errors, then
 * the caption if the sender wrote one.
 */
export function voicePrompt(transcript: Transcript, seconds: number | null, caption: string): string {
  const length = seconds === null ? "" : `, ${clock(seconds)}`;
  const heard = `[Voice note${length}, transcribed] ${transcript.text.trim()}`;
  return caption.trim() === "" ? heard : `${caption.trim()}\n${heard}`;
}

/** What the agent reads in place of a voice note it cannot hear. */
export function voiceNote(name: string, reason: string): string {
  return `[The user sent a voice note, ${name}, but ${reason}.]`;
}

/** The notice posted under the voice note, so the sender sees what was heard. */
export function transcriptNotice(transcript: Transcript): string {
  return `Transcript: ${transcript.text.trim()}`;
}

/** The service answered, and not with a 2xx. The message names the status. */
export class TranscriptionHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`the transcription service answered ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    this.name = "TranscriptionHttpError";
  }
}

/**
 * The structured transcript that rides on the notice under
 * `dev.agentpod.voice_transcript`, so a client that knows the key draws the
 * words as part of the voice note. The `body` stays the fallback.
 */
export function transcriptContent(transcript: Transcript, seconds: number | null): Record<string, unknown> {
  const card: VoiceTranscript = {
    schema_version: 1,
    text: transcript.text.trim().slice(0, 20_000),
    ...(transcript.language ? { language: transcript.language.slice(0, 16) } : {}),
    ...(seconds !== null ? { seconds: Math.min(3600, Math.max(0, Math.round(seconds))) } : {}),
  };
  return { [VOICE_TRANSCRIPT_CONTENT_KEY]: card };
}

/**
 * A client for any service with OpenAI's transcription API.
 *
 * `baseUrl` without the path: `http://foundry:8840`, `https://api.openai.com`,
 * `https://api.groq.com/openai`.
 */
export function openAiTranscriber(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Transcriber {
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`;
  // Five minutes of audio takes ~82 s on foundry's CPU; a queue ahead of it
  // takes as long again. Beyond this something is wrong, not slow.
  const timeoutMs = opts.timeoutMs ?? 6 * 60_000;

  return {
    async transcribe(audio, meta) {
      const form = new FormData();
      form.append("file", new Blob([audio], { type: meta.mimeType || "application/octet-stream" }), meta.name);
      form.append("model", opts.model);
      form.append("response_format", "json");
      const res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new TranscriptionHttpError(res.status, detail);
      }
      const body = (await res.json()) as { text?: unknown; language?: unknown };
      if (typeof body.text !== "string") throw new Error("the transcription service returned no text");
      return { text: body.text, language: typeof body.language === "string" ? body.language : null };
    },
  };
}

/** The model asked for when nobody named one — what `deploy/transcriber` serves. */
export const DEFAULT_TRANSCRIBE_MODEL = "large-v3-turbo";

/** Where a transcription service is and how to ask it. */
export interface TranscriptionEndpoint {
  url: string;
  apiKey: string;
  model: string;
}

/**
 * The service the environment names, or null. `TRANSCRIBE_URL` turns it on;
 * `TRANSCRIBE_API_KEY` and `TRANSCRIBE_MODEL` go with it. This is the fallback
 * beneath the console's settings (`services/transcription-settings.ts`).
 */
export function transcriptionFromEnv(env: Record<string, string | undefined> = process.env): TranscriptionEndpoint | null {
  const url = env.TRANSCRIBE_URL?.trim();
  if (!url) return null;
  return {
    url,
    apiKey: env.TRANSCRIBE_API_KEY?.trim() ?? "",
    model: env.TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL,
  };
}

/** The transcriber the environment configures, or null. */
export function transcriberFromEnv(env: Record<string, string | undefined> = process.env): Transcriber | null {
  const endpoint = transcriptionFromEnv(env);
  if (!endpoint) return null;
  return openAiTranscriber({ baseUrl: endpoint.url, apiKey: endpoint.apiKey, model: endpoint.model });
}

/**
 * One second of silence: 16 kHz, mono, 16-bit PCM WAV. The smallest audio
 * every OpenAI-compatible service accepts, so a connection test proves the
 * URL, the key and the model without anyone having to record anything.
 */
export function silentWav(): Uint8Array {
  const rate = 16_000;
  const dataBytes = rate * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

export interface TranscriptionTestResult {
  ok: boolean;
  /** The HTTP status, when the service answered at all. */
  status?: number;
  error?: string;
  elapsedMs: number;
}

/**
 * Send one second of silence to a service and say whether it worked. A 200
 * with empty text is a pass — there were no words to hear.
 */
export async function testTranscription(
  endpoint: TranscriptionEndpoint,
  opts: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number } = {}
): Promise<TranscriptionTestResult> {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const transcriber = openAiTranscriber({
    baseUrl: endpoint.url,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  try {
    await transcriber.transcribe(silentWav(), { mimeType: "audio/wav", name: "agentpod-test.wav" });
    return { ok: true, status: 200, elapsedMs: Math.round(now() - started) };
  } catch (err) {
    const elapsedMs = Math.round(now() - started);
    if (err instanceof TranscriptionHttpError) return { ok: false, status: err.status, error: err.message, elapsedMs };
    return { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs };
  }
}
