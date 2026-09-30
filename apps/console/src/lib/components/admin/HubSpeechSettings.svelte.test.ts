/**
 * Admin → Speech: the hub's default text-to-speech service for spoken replies.
 *
 * As for transcription, the form must never echo a key it cannot see: keep,
 * clear and replace are each asserted against the body that would be sent.
 * The test plays its clip; the voice picker offers the service's voices.
 */

import { test, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("svelte-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import HubSpeechSettings from "./HubSpeechSettings.svelte";
import type { HubSpeech, HubSpeechInput, VoiceList } from "$lib/api/speech";

const FROM_ENV: HubSpeech = {
  enabled: true,
  url: "http://100.78.52.87:8841",
  defaultVoice: "",
  mode: "voice_in",
  maxChars: 1500,
  hasApiKey: true,
  source: "env",
};

const VOICES: VoiceList = {
  voices: [
    { id: "af_heart", name: "Heart", accent: "US", gender: "female", grade: "A", preview_url: "/api/speech/voices/af_heart/preview" },
    { id: "bm_george", name: "George", accent: "UK", gender: "male", grade: "C", preview_url: "/api/speech/voices/bm_george/preview" },
  ],
  default: "af_heart",
  aliases: {},
  assignable: ["af_heart"],
};

function setup(initial: HubSpeech = FROM_ENV) {
  const load = vi.fn(async () => initial);
  const save = vi.fn(async (input: HubSpeechInput): Promise<HubSpeech> => ({
    ...initial,
    ...input,
    hasApiKey: input.apiKey === undefined ? initial.hasApiKey : typeof input.apiKey === "string",
    source: "settings" as const,
  }));
  const testConnection = vi.fn(async () => ({ ok: true, status: 200, elapsedMs: 812, durationMs: 4200, audio: "T2dnUw==" }));
  const loadVoices = vi.fn(async () => VOICES);
  const play = vi.fn();
  const preview = vi.fn(async () => new Blob(["ogg"], { type: "audio/ogg" }));
  const r = render(HubSpeechSettings, { load, save, testConnection, loadVoices, play, preview });
  return { ...r, load, save, testConnection, play, preview };
}

test("says where the config comes from, shows a saved key only as saved, and lists the voices", async () => {
  const { findByText, getByTestId, getByLabelText } = setup();
  await findByText(/From the hub's environment \(SPEECH_URL\)/);
  expect(getByTestId("api-key-saved").textContent).toContain("•••• saved");
  expect((getByLabelText("Service URL") as HTMLInputElement).value).toBe("http://100.78.52.87:8841");
  await waitFor(() => {
    const select = getByLabelText("Default voice") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Each agent its own voice",
      "Heart · A",
      "George · C",
      "Custom or blend…",
    ]);
  });
});

test("saving without touching the key keeps it: no apiKey in the body", async () => {
  const { findByText, getByRole, save } = setup();
  await findByText(/From the hub's environment/);
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const body = save.mock.calls[0]![0] as unknown as Record<string, unknown>;
  expect(body.apiKey).toBeUndefined();
  expect(body).toMatchObject({ enabled: true, url: "http://100.78.52.87:8841", defaultVoice: "", mode: "voice_in", maxChars: 1500 });
});

test("Clear sends null; Replace sends the new key", async () => {
  const { findByText, getByRole, getByLabelText, save } = setup();
  await findByText(/From the hub's environment/);
  await fireEvent.click(getByRole("button", { name: "Clear" }));
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0].apiKey).toBeNull();

  // Cleared and saved: no key now, so a plain box to type one into.
  const box = getByLabelText("API key") as HTMLInputElement;
  await fireEvent.input(box, { target: { value: "sk-new" } });
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]![0].apiKey).toBe("sk-new");
});

test("a chosen default voice and speak mode are saved", async () => {
  const { findByText, getByRole, getByLabelText, save } = setup();
  await findByText(/From the hub's environment/);
  await waitFor(() => expect((getByLabelText("Default voice") as HTMLSelectElement).options.length).toBe(4));
  await fireEvent.change(getByLabelText("Default voice"), { target: { value: "bm_george" } });
  await fireEvent.click(getByLabelText("Always"));
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0]).toMatchObject({ defaultVoice: "bm_george", mode: "always" });
});

test("Test and play reports the result and plays the clip", async () => {
  const { findByText, getByRole, findByTestId, testConnection, play } = setup();
  await findByText(/From the hub's environment/);
  await fireEvent.click(getByRole("button", { name: "Test and play" }));
  const result = await findByTestId("hub-speech-test-result");
  expect(result.textContent).toContain("4.2 s");
  expect(result.textContent).toContain("812 ms");
  expect(testConnection).toHaveBeenCalledWith({ url: "http://100.78.52.87:8841" });
  expect(play).toHaveBeenCalledWith("T2dnUw==");
});

test("a voice's sample plays through the hub", async () => {
  const { findByText, getByLabelText, getByRole, preview, play } = setup();
  await findByText(/From the hub's environment/);
  await waitFor(() => expect((getByLabelText("Default voice") as HTMLSelectElement).options.length).toBe(4));
  await fireEvent.change(getByLabelText("Default voice"), { target: { value: "bm_george" } });
  await fireEvent.click(getByRole("button", { name: /Play a sample of George/ }));
  await waitFor(() => expect(preview).toHaveBeenCalledWith("bm_george"));
  expect(play).toHaveBeenCalledOnce();
});

test("a length outside 100–4096 cannot be saved", async () => {
  const { findByText, getByRole, getByLabelText } = setup();
  await findByText(/From the hub's environment/);
  await fireEvent.input(getByLabelText(/Longest reply spoken/), { target: { value: "50" } });
  expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});
