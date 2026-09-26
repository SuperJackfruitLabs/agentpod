/**
 * A station's Voice notes setting: inherit the hub default, turn it off, or
 * name a service of its own — and always say which service is actually in
 * effect, because "inherit" on its own tells an operator nothing.
 */

import { test, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("svelte-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import VoiceNotesField from "./VoiceNotesField.svelte";
import type { StationTranscription, StationTranscriptionInput } from "$lib/api/transcription";

const INHERITED: StationTranscription = {
  mode: "inherit",
  hasApiKey: false,
  effective: { enabled: true, url: "https://api.groq.com/openai", model: "whisper-large-v3-turbo", maxSeconds: 300, source: "hub" },
};

function setup(initial: StationTranscription = INHERITED, harness = false) {
  const load = vi.fn(async () => initial);
  const save = vi.fn(async (_id: string, input: StationTranscriptionInput): Promise<StationTranscription> => ({
    mode: input.mode as StationTranscription["mode"],
    hasApiKey: typeof input.apiKey === "string",
    effective:
      input.mode === "off"
        ? { enabled: false, url: null, model: null, maxSeconds: null, source: "none" }
        : input.mode === "custom"
          ? { enabled: true, url: String(input.url), model: String(input.model), maxSeconds: Number(input.maxSeconds), source: "station" }
          : initial.effective,
  }));
  const r = render(VoiceNotesField, { stationId: "st_1", harnessMode: harness, load, save });
  return { ...r, load, save };
}

test("inherit shows the effective provider and where it comes from", async () => {
  const { findByTestId } = setup();
  const effective = await findByTestId("voice-effective");
  expect(effective.textContent).toContain("Groq");
  expect(effective.textContent).toContain("whisper-large-v3-turbo");
  expect(effective.textContent).toMatch(/hub default/i);
});

test("off is saved as off, and then says voice notes are not transcribed", async () => {
  const { findByTestId, getByLabelText, getByRole, save } = setup();
  await findByTestId("voice-effective");
  await fireEvent.click(getByLabelText("Off"));
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("st_1", { mode: "off" }));
  expect((await findByTestId("voice-effective")).textContent).toMatch(/not transcribed/i);
});

test("custom reveals the service fields and saves them, key included", async () => {
  const { findByTestId, getByLabelText, getByRole, queryByLabelText, save } = setup();
  await findByTestId("voice-effective");
  expect(queryByLabelText("URL")).toBeNull();

  await fireEvent.click(getByLabelText("Custom"));
  await fireEvent.change(getByLabelText("Provider"), { target: { value: "openai" } });
  await fireEvent.input(getByLabelText("API key"), { target: { value: "sk-test-station" } });
  await fireEvent.click(getByRole("button", { name: "Save" }));

  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![1]).toEqual({
    mode: "custom",
    url: "https://api.openai.com",
    model: "whisper-1",
    maxSeconds: 300,
    apiKey: "sk-test-station",
  });
});

test("a custom service with no URL cannot be saved", async () => {
  const { findByTestId, getByLabelText, getByRole } = setup();
  await findByTestId("voice-effective");
  await fireEvent.click(getByLabelText("Custom"));
  await fireEvent.change(getByLabelText("Provider"), { target: { value: "custom" } });
  expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a harness-mode station says the harness applies it, and that pushing is coming", async () => {
  const { findByTestId } = setup(INHERITED, true);
  expect((await findByTestId("voice-harness-note")).textContent).toMatch(/coming soon/i);
});

test("a bridge-mode station has no such note", async () => {
  const { findByTestId, queryByTestId } = setup();
  await findByTestId("voice-effective");
  expect(queryByTestId("voice-harness-note")).toBeNull();
});
