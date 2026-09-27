import { describe, expect, test } from "vitest";
import {
  PRESETS,
  presetFor,
  describeSource,
  maxSecondsProblem,
  urlProblem,
} from "./transcription";

describe("provider presets", () => {
  test("self-hosted, OpenAI, Groq and custom, with the URLs and models each serves", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["self-hosted", "openai", "groq", "custom"]);
    const openai = PRESETS.find((p) => p.id === "openai")!;
    expect(openai.url).toBe("https://api.openai.com");
    expect(openai.models).toEqual(["whisper-1", "gpt-4o-transcribe"]);
    const groq = PRESETS.find((p) => p.id === "groq")!;
    expect(groq.url).toBe("https://api.groq.com/openai");
    expect(groq.models).toEqual(["whisper-large-v3-turbo"]);
    expect(PRESETS.find((p) => p.id === "self-hosted")!.models[0]).toBe("large-v3-turbo");
  });

  test("a saved URL is recognised as its provider, ignoring a trailing slash", () => {
    expect(presetFor("https://api.openai.com/")).toBe("openai");
    expect(presetFor("https://api.groq.com/openai")).toBe("groq");
    // Anything else on a private address or elsewhere: it's ours or custom.
    expect(presetFor("http://100.78.52.87:8840")).toBe("custom");
    expect(presetFor("")).toBe("self-hosted");
  });
});

describe("validation", () => {
  test("url must be http(s)", () => {
    expect(urlProblem("https://api.openai.com")).toBeNull();
    expect(urlProblem("http://100.78.52.87:8840")).toBeNull();
    expect(urlProblem("ftp://x")).toMatch(/http/);
    expect(urlProblem("nope")).toMatch(/http/);
    expect(urlProblem("", { required: false })).toBeNull();
    expect(urlProblem("", { required: true })).toMatch(/required/i);
  });

  test("max seconds is a whole number from 10 to 600", () => {
    expect(maxSecondsProblem(300)).toBeNull();
    expect(maxSecondsProblem(10)).toBeNull();
    expect(maxSecondsProblem(600)).toBeNull();
    expect(maxSecondsProblem(9)).not.toBeNull();
    expect(maxSecondsProblem(601)).not.toBeNull();
    expect(maxSecondsProblem(12.5)).not.toBeNull();
    expect(maxSecondsProblem(Number.NaN)).not.toBeNull();
  });
});

describe("describeSource", () => {
  test("says where a config comes from in words", () => {
    expect(describeSource("settings")).toMatch(/saved/i);
    expect(describeSource("env")).toMatch(/TRANSCRIBE_URL/);
    expect(describeSource("none")).toMatch(/not set up/i);
    expect(describeSource("station")).toMatch(/this station/i);
    expect(describeSource("hub")).toMatch(/hub default/i);
  });
});
