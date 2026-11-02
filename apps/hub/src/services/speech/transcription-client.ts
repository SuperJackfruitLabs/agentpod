/**
 * A client for any speech-to-text service with OpenAI's
 * `POST /v1/audio/transcriptions`: AgentPod's own transcriber
 * (`deploy/transcriber`, faster-whisper on foundry), or a hosted provider.
 * The counterpart of `speech-client.ts`, which speaks.
 *
 * Used by the Matrix bridge to hear voice notes (`matrix-as/voice.ts`) and by
 * the transcription settings (`transcription-settings.ts`), which is why it
 * lives here rather than inside `matrix-as/`.
 */

/**
 * The longest voice note transcribed by default. Longer ones are named, not
 * heard. A hub or station setting can move it (`transcription-settings.ts`).
 */
export const MAX_VOICE_SECONDS = 300;

/** What a transcription service returned. */
export interface Transcript {
  text: string;
  /** The language it heard, as an ISO code, when it said. */
  language: string | null;
}

export interface Transcriber {
  transcribe(audio: Uint8Array, meta: { mimeType: string; name: string }): Promise<Transcript>;
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
 * beneath the console's settings (`services/speech/transcription-settings.ts`).
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
