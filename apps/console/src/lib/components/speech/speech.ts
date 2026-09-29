/**
 * The rules behind the spoken-reply forms, kept out of the components so
 * they can be tested without a DOM. The hub validates all of it again.
 */

import type { SpeakMode, VoiceInfo } from "$lib/api/speech";

export const MIN_MAX_CHARS = 100;
export const MAX_MAX_CHARS = 4096;
export const DEFAULT_MAX_CHARS = 1500;

export const SPEAK_MODE_LABELS: Record<SpeakMode, string> = {
  off: "Never",
  voice_in: "When you send a voice note",
  always: "Always",
};

export interface VoiceGroup {
  label: string;
  voices: VoiceInfo[];
}

const GRADE_ORDER = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+", "F", "F-"];
const gradeRank = (g: string) => {
  const i = GRADE_ORDER.indexOf(g);
  return i === -1 ? GRADE_ORDER.length : i;
};

/** US then UK, female then male; best-graded first within each. */
export function groupVoices(voices: VoiceInfo[]): VoiceGroup[] {
  const order: Array<[string, string]> = [
    ["US", "female"],
    ["US", "male"],
    ["UK", "female"],
    ["UK", "male"],
  ];
  return order
    .map(([accent, gender]) => ({
      label: `${accent} · ${gender}`,
      voices: voices
        .filter((v) => v.accent === accent && v.gender === gender)
        .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade)),
    }))
    .filter((g) => g.voices.length > 0);
}

/** `Emma (UK female, B-)`, or the id as written for a blend or an unknown voice. */
export function voiceLabel(id: string, voices: VoiceInfo[]): string {
  const v = voices.find((x) => x.id === id);
  return v ? `${v.name} (${v.accent} ${v.gender}, ${v.grade})` : id;
}

const VOICE_SPEC = /^[A-Za-z0-9_]+(:[0-9.]+)?(\+[A-Za-z0-9_]+(:[0-9.]+)?){0,3}$/;

/** A voice id or a blend like `af_heart:60+af_bella:40`; "" is "not set". */
export function voiceProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (v.length > 64 || !VOICE_SPEC.test(v)) {
    return "A voice id, or a blend of up to four like af_heart:60+af_bella:40.";
  }
  return null;
}

export function maxCharsProblem(value: number): string | null {
  if (!Number.isInteger(value) || value < MIN_MAX_CHARS || value > MAX_MAX_CHARS) {
    return `A whole number of characters, ${MIN_MAX_CHARS}–${MAX_MAX_CHARS}.`;
  }
  return null;
}

export function describeSpeechSource(source: "settings" | "env" | "none" | "station" | "hub"): string {
  switch (source) {
    case "settings":
      return "Saved in the console.";
    case "env":
      return "From the hub's environment (SPEECH_URL). Saving here takes over from it.";
    case "none":
      return "Not set up: agents reply in text only.";
    case "station":
      return "This station's own service.";
    case "hub":
      return "The hub default.";
  }
}

/** Play base64 Ogg (a test clip) or a Blob (a preview). Returns the element so a caller may stop it. */
export function playAudio(source: Blob | string): HTMLAudioElement {
  const blob =
    typeof source === "string"
      ? new Blob([Uint8Array.from(atob(source), (c) => c.charCodeAt(0))], { type: "audio/ogg" })
      : source;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  void audio.play().catch(() => URL.revokeObjectURL(url));
  return audio;
}
