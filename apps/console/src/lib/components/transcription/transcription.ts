/**
 * The rules behind the transcription forms, kept out of the components so
 * they can be tested without a DOM — the same split `purpose.ts` makes.
 *
 * The hub validates all of this again; these exist so the form can say what
 * is wrong before a round trip, not instead of the server saying it.
 */

export const MIN_MAX_SECONDS = 10;
export const MAX_MAX_SECONDS = 600;
export const DEFAULT_MAX_SECONDS = 300;
export const DEFAULT_MODEL = "large-v3-turbo";

export type PresetId = "self-hosted" | "openai" | "groq" | "custom";

export interface Preset {
  id: PresetId;
  label: string;
  /** Filled into the URL field on choosing it; empty means "type your own". */
  url: string;
  /** The models offered for it, first is the default. */
  models: string[];
  hint: string;
}

/**
 * Anything that speaks OpenAI's `/v1/audio/transcriptions`. The URL is the
 * base, without that path — the hub adds it.
 */
export const PRESETS: Preset[] = [
  {
    id: "self-hosted",
    label: "Self-hosted",
    url: "",
    models: [DEFAULT_MODEL],
    hint: "AgentPod's own faster-whisper service (deploy/transcriber). Enter its address.",
  },
  {
    id: "openai",
    label: "OpenAI",
    url: "https://api.openai.com",
    models: ["whisper-1", "gpt-4o-transcribe"],
    hint: "Needs an OpenAI API key.",
  },
  {
    id: "groq",
    label: "Groq",
    url: "https://api.groq.com/openai",
    models: ["whisper-large-v3-turbo"],
    hint: "Needs a Groq API key.",
  },
  {
    id: "custom",
    label: "Custom",
    url: "",
    models: [],
    hint: "Any service with an OpenAI-compatible transcription API.",
  },
];

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");

/** Which preset a saved URL belongs to. An empty URL starts on Self-hosted. */
export function presetFor(url: string): PresetId {
  const u = trimSlash(url);
  if (u === "") return "self-hosted";
  const hosted = PRESETS.find((p) => p.url !== "" && trimSlash(p.url) === u);
  return hosted?.id ?? "custom";
}

export function urlProblem(url: string, opts: { required?: boolean } = {}): string | null {
  const u = url.trim();
  if (u === "") return opts.required ? "A URL is required." : null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return null;
  } catch {
    // fall through
  }
  return "Must be an http:// or https:// address.";
}

export function maxSecondsProblem(value: number): string | null {
  if (!Number.isInteger(value) || value < MIN_MAX_SECONDS || value > MAX_MAX_SECONDS) {
    return `A whole number of seconds, ${MIN_MAX_SECONDS}–${MAX_MAX_SECONDS}.`;
  }
  return null;
}

/** Where a config comes from, for the line under the form. */
export function describeSource(source: "settings" | "env" | "none" | "station" | "hub"): string {
  switch (source) {
    case "settings":
      return "Saved in the console.";
    case "env":
      return "From the hub's environment (TRANSCRIBE_URL). Saving here takes over from it.";
    case "none":
      return "Not set up: voice notes reach agents as a file name only.";
    case "station":
      return "This station's own service.";
    case "hub":
      return "The hub default.";
  }
}

/** `2 min`, `90 s`. */
export function formatSeconds(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/** The name a URL is known by — a preset's label, or its host. */
export function providerName(url: string | null): string {
  if (!url) return "none";
  const id = presetFor(url);
  if (id !== "custom" && id !== "self-hosted") return PRESETS.find((p) => p.id === id)!.label;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
