import { describe, expect, test } from "vitest";
import {
  describeSpeechSource,
  groupVoices,
  maxCharsProblem,
  SPEAK_MODE_LABELS,
  voiceLabel,
  voiceProblem,
} from "./speech";
import type { VoiceInfo } from "$lib/api/speech";

const v = (id: string, grade: string): VoiceInfo => ({
  id,
  name: id.split("_")[1]!.replace(/^./, (c) => c.toUpperCase()),
  accent: id[0] === "a" ? "US" : "UK",
  gender: id[1] === "f" ? "female" : "male",
  grade,
  preview_url: `/api/speech/voices/${id}/preview`,
});

const VOICES = [v("af_heart", "A"), v("am_michael", "C+"), v("bf_emma", "B-"), v("bm_george", "C"), v("af_bella", "A-")];

describe("groupVoices", () => {
  test("US then UK, female then male, best grade first within each", () => {
    const groups = groupVoices(VOICES);
    expect(groups.map((g) => g.label)).toEqual(["US · female", "US · male", "UK · female", "UK · male"]);
    expect(groups[0]!.voices.map((x) => x.id)).toEqual(["af_heart", "af_bella"]);
  });

  test("empty groups are left out", () => {
    expect(groupVoices([v("bf_emma", "B-")]).map((g) => g.label)).toEqual(["UK · female"]);
  });
});

describe("voiceLabel", () => {
  test("a known voice by name, accent, gender and grade", () => {
    expect(voiceLabel("bf_emma", VOICES)).toBe("Emma (UK female, B-)");
  });

  test("a blend or an unknown id is shown as written", () => {
    expect(voiceLabel("af_heart:60+af_bella:40", VOICES)).toBe("af_heart:60+af_bella:40");
    expect(voiceLabel("af_heart", [])).toBe("af_heart");
  });
});

describe("voiceProblem", () => {
  test("a voice id or a blend of up to four is fine; anything else says why", () => {
    expect(voiceProblem("af_heart")).toBeNull();
    expect(voiceProblem("af_heart:60+af_bella:40")).toBeNull();
    expect(voiceProblem("")).toBeNull();
    expect(voiceProblem("a+b+c+d+e")).not.toBeNull();
    expect(voiceProblem("af heart")).not.toBeNull();
    expect(voiceProblem("x".repeat(65))).not.toBeNull();
  });
});

describe("maxCharsProblem", () => {
  test("a whole number, 100–4096", () => {
    expect(maxCharsProblem(1500)).toBeNull();
    expect(maxCharsProblem(99)).not.toBeNull();
    expect(maxCharsProblem(4097)).not.toBeNull();
    expect(maxCharsProblem(150.5)).not.toBeNull();
  });
});

describe("labels", () => {
  test("speak modes say when an agent speaks", () => {
    expect(SPEAK_MODE_LABELS).toEqual({
      off: "Never",
      voice_in: "When you send a voice note",
      always: "Always",
    });
  });

  test("the source line says whether the env or the console answers", () => {
    expect(describeSpeechSource("env")).toMatch(/SPEECH_URL/);
    expect(describeSpeechSource("settings")).toMatch(/console/);
    expect(describeSpeechSource("none")).toMatch(/text only/);
  });
});
