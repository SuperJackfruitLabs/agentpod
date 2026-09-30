/**
 * A station's Voice replies: the voice it speaks in (its assigned one unless
 * chosen), when it speaks, and — tucked away — its speech service. It always
 * says what is in effect, and a harness-mode station is told its voice is
 * applied to its harness later, without the picker being hidden.
 */

import { test, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("svelte-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import VoiceRepliesField from "./VoiceRepliesField.svelte";
import type { StationSpeech, StationSpeechInput, VoiceList } from "$lib/api/speech";

const INHERITED: StationSpeech = {
  mode: "inherit",
  hasApiKey: false,
  assignedVoice: "bf_emma",
  inheritedVoice: "bf_emma",
  inheritedVoiceSource: "assigned",
  effective: {
    enabled: true,
    url: "http://100.78.52.87:8841",
    voice: "bf_emma",
    voiceSource: "assigned",
    speakMode: "voice_in",
    maxChars: 1500,
    source: "hub",
  },
};

const VOICES: VoiceList = {
  voices: [
    { id: "af_heart", name: "Heart", accent: "US", gender: "female", grade: "A", preview_url: "" },
    { id: "bf_emma", name: "Emma", accent: "UK", gender: "female", grade: "B-", preview_url: "" },
    { id: "bm_george", name: "George", accent: "UK", gender: "male", grade: "C", preview_url: "" },
  ],
  default: "af_heart",
  aliases: {},
  assignable: [],
};

function setup(initial: StationSpeech = INHERITED, harness = false, voices: () => Promise<VoiceList> = async () => VOICES) {
  const load = vi.fn(async () => initial);
  const save = vi.fn(async (_id: string, input: StationSpeechInput): Promise<StationSpeech> => ({
    ...initial,
    mode: input.mode,
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.speakMode ? { speakMode: input.speakMode } : {}),
    effective: {
      ...initial.effective,
      ...(input.voice ? { voice: input.voice, voiceSource: "station" as const } : {}),
      ...(input.speakMode ? { speakMode: input.speakMode } : {}),
    },
  }));
  const preview = vi.fn(async () => new Blob(["ogg"]));
  const play = vi.fn();
  const r = render(VoiceRepliesField, { stationId: "st_1", harnessMode: harness, load, save, loadVoices: voices, preview, play });
  return { ...r, load, save, preview, play };
}

test("shows the assigned voice as the default choice, and what is in effect", async () => {
  const { findByTestId, getByLabelText } = setup();
  const effective = await findByTestId("voice-replies-effective");
  await waitFor(() => expect(effective.textContent).toContain("Emma (UK female, B-)"));
  expect(effective.textContent).toMatch(/when you send a voice note/i);
  const select = getByLabelText("Voice") as HTMLSelectElement;
  expect(select.value).toBe("");
  expect(select.options[0]!.textContent).toBe("Assigned: Emma (UK female, B-)");
  const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
  expect(groups).toEqual(["US · female", "UK · female", "UK · male"]);
});

test("picking a voice and a speak mode saves both, leaving the service inherited", async () => {
  const { findByTestId, getByLabelText, getByRole, save } = setup();
  await findByTestId("voice-replies-effective");
  await waitFor(() => expect((getByLabelText("Voice") as HTMLSelectElement).options.length).toBe(5));
  await fireEvent.change(getByLabelText("Voice"), { target: { value: "bm_george" } });
  await fireEvent.click(getByLabelText("Always"));
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]).toEqual(["st_1", { mode: "inherit", voice: "bm_george", speakMode: "always" }]);
});

test("a blend can be typed", async () => {
  const { findByTestId, getByLabelText, getByRole, save } = setup();
  await findByTestId("voice-replies-effective");
  await waitFor(() => expect((getByLabelText("Voice") as HTMLSelectElement).options.length).toBe(5));
  await fireEvent.change(getByLabelText("Voice"), { target: { value: "__custom__" } });
  await fireEvent.input(getByLabelText("Voice id or blend"), { target: { value: "af_heart:60+bf_emma:40" } });
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![1].voice).toBe("af_heart:60+bf_emma:40");
});

test("a malformed voice cannot be saved", async () => {
  const { findByTestId, getByLabelText, getByRole, save } = setup();
  await findByTestId("voice-replies-effective");
  await waitFor(() => expect((getByLabelText("Voice") as HTMLSelectElement).options.length).toBe(5));
  await fireEvent.change(getByLabelText("Voice"), { target: { value: "__custom__" } });
  await fireEvent.input(getByLabelText("Voice id or blend"), { target: { value: "not a voice" } });
  expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

test("the preview plays the assigned voice when none is chosen", async () => {
  const { findByTestId, getByRole, preview, play } = setup();
  await findByTestId("voice-replies-effective");
  await waitFor(() => expect(getByRole("button", { name: /Play a sample of Emma/ })).toBeTruthy());
  await fireEvent.click(getByRole("button", { name: /Play a sample of Emma/ }));
  await waitFor(() => expect(preview).toHaveBeenCalledWith("bf_emma"));
  expect(play).toHaveBeenCalledOnce();
});

test("a harness-mode station keeps the picker and is told the voice is applied later", async () => {
  const { findByTestId, getByLabelText } = setup(INHERITED, true);
  expect((await findByTestId("voice-replies-harness-note")).textContent).toMatch(/later update/);
  expect(getByLabelText("Voice")).toBeTruthy();
});

test("no voice list: a voice id can still be typed", async () => {
  const { findByTestId, getByLabelText } = setup(INHERITED, false, async () => {
    throw new Error("no speech service is configured on this hub");
  });
  expect((await findByTestId("voice-list-error")).textContent).toContain("no speech service");
  expect(getByLabelText("Voice id or blend")).toBeTruthy();
});

test("no service in effect says replies stay text", async () => {
  const { findByTestId } = setup({
    ...INHERITED,
    mode: "off",
    effective: { ...INHERITED.effective, enabled: false, url: null, source: "none" },
  });
  expect((await findByTestId("voice-replies-effective")).textContent).toMatch(/replies stay text/);
});
