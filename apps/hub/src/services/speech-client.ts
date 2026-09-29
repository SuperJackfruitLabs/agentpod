/**
 * A client for AgentPod's speech service (`deploy/speech`), or anything with
 * OpenAI's `POST /v1/audio/speech`.
 *
 * `synthesize` asks for Ogg/Opus — what a Matrix voice message is — and for
 * the service's opt-in `X-Audio-Waveform`, the MSC3246 bars a client draws. A
 * service that does not send one (OpenAI's) still works: the voice message
 * then has a duration and no waveform. The text is sent as the agent wrote
 * it; the service normalises markdown, code and numbers itself. It is never
 * logged here.
 */

export interface SpeechEndpoint {
  url: string;
  apiKey: string;
}

export interface SpokenAudio {
  audio: Uint8Array;
  mimeType: string;
  /** From `X-Audio-Duration-Ms`, when the service said. */
  durationMs: number | null;
  /** From `X-Audio-Waveform`: 0..1024 per point, when the service sent it. */
  waveform: number[] | null;
}

/** The service answered, and not with a 2xx. */
export class SpeechHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`the speech service answered ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    this.name = "SpeechHttpError";
  }
}

/** A reply is spoken in well under this; the service's own deadline is 120 s. */
export const SPEECH_TIMEOUT_MS = 150_000;

/** The most waveform points kept — MSC3246 suggests no more than 100; 256 is generous. */
const MAX_WAVEFORM_POINTS = 256;

function base(url: string): string {
  return url.replace(/\/+$/, "");
}

function auth(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** `X-Audio-Waveform` as integers 0..1024, or null when absent or not one. */
export function parseWaveform(header: string | null): number[] | null {
  if (!header || header.trim() === "") return null;
  const points = header
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.min(1024, Math.max(0, Math.round(n))));
  if (points.length === 0) return null;
  return points.slice(0, MAX_WAVEFORM_POINTS);
}

export async function synthesize(
  endpoint: SpeechEndpoint,
  request: { text: string; voice: string },
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<SpokenAudio> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${base(endpoint.url)}/v1/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Want-Waveform": "1",
      ...auth(endpoint.apiKey),
    },
    body: JSON.stringify({
      // Ignored by deploy/speech; OpenAI needs one.
      model: "tts-1",
      input: request.text,
      voice: request.voice,
      response_format: "opus",
      waveform: true,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? SPEECH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new SpeechHttpError(res.status, detail);
  }
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.length === 0) throw new Error("the speech service returned no audio");
  const duration = Number(res.headers.get("x-audio-duration-ms"));
  return {
    audio,
    mimeType: "audio/ogg",
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    waveform: parseWaveform(res.headers.get("x-audio-waveform")),
  };
}

export interface SpeechTestResult {
  ok: boolean;
  status?: number;
  error?: string;
  elapsedMs: number;
  durationMs?: number;
  /** The test clip, base64 Ogg/Opus, so the console can play it. */
  audio?: string;
}

export const TEST_SENTENCE = "Hello! This is how your agents will sound when they reply with a voice note.";

/** Speak one short sentence and say whether it worked. */
export async function testSpeech(
  endpoint: SpeechEndpoint,
  opts: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number; voice?: string } = {}
): Promise<SpeechTestResult> {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  try {
    const spoken = await synthesize(
      endpoint,
      { text: TEST_SENTENCE, voice: opts.voice || "af_heart" },
      { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 60_000 }
    );
    return {
      ok: true,
      status: 200,
      elapsedMs: Math.round(now() - started),
      ...(spoken.durationMs !== null ? { durationMs: spoken.durationMs } : {}),
      audio: Buffer.from(spoken.audio).toString("base64"),
    };
  } catch (err) {
    const elapsedMs = Math.round(now() - started);
    if (err instanceof SpeechHttpError) return { ok: false, status: err.status, error: err.message, elapsedMs };
    return { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs };
  }
}

/** `GET /v1/voices`, as the service answers it. */
export async function fetchVoices(
  endpoint: SpeechEndpoint,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${base(endpoint.url)}/v1/voices`, {
    headers: auth(endpoint.apiKey),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new SpeechHttpError(res.status, await res.text().catch(() => ""));
  return res.json();
}

/** `GET /v1/voices/{id}/preview`: the service's response, for streaming through. */
export async function fetchPreview(
  endpoint: SpeechEndpoint,
  voiceId: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  return doFetch(`${base(endpoint.url)}/v1/voices/${encodeURIComponent(voiceId)}/preview`, {
    headers: auth(endpoint.apiKey),
    // A preview not yet cached is synthesised on the service: seconds, not ms.
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
}
