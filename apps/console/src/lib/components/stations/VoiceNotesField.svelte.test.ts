/**
 * A station's Voice notes setting: inherit the hub default, turn it off, or
 * name a service of its own — and always say which service is actually in
 * effect, because "inherit" on its own tells an operator nothing.
 */

import { test, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("svelte-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import VoiceNotesField from "./VoiceNotesField.svelte";
import type {
  StationTranscription,
  StationTranscriptionInput,
  TranscriptionApplyResult,
} from "$lib/api/transcription";

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

function setupApply(apply: (id: string) => Promise<TranscriptionApplyResult>) {
  const load = vi.fn(async () => INHERITED);
  const save = vi.fn();
  const r = render(VoiceNotesField, { stationId: "st_1", harnessMode: true, load, save, apply });
  return { ...r, apply };
}

test("a harness-mode station says the harness transcribes, and offers to apply the setting to it", async () => {
  const { findByTestId, getByRole } = setup(INHERITED, true);
  const note = await findByTestId("voice-harness-note");
  expect(note.textContent).toMatch(/harness transcribes/i);
  expect(note.textContent).not.toMatch(/coming soon/i);
  expect(getByRole("button", { name: "Apply to harness" })).toBeTruthy();
});

test("apply shows progress, then says it restarted", async () => {
  let finish!: (r: TranscriptionApplyResult) => void;
  const apply = vi.fn(() => new Promise<TranscriptionApplyResult>((res) => (finish = res)));
  const { findByTestId, getByRole, findByRole } = setupApply(apply);
  await findByTestId("voice-effective");
  await fireEvent.click(getByRole("button", { name: "Apply to harness" }));
  expect(apply).toHaveBeenCalledWith("st_1");
  const busy = (await findByRole("button", { name: "Applying…" })) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  finish({ applied: true, mode: "on", model: "large-v3-turbo", restarted: true });
  expect((await findByTestId("voice-apply-result")).textContent).toMatch(/Applied — restarted/);
});

test("apply without a restart says the gateway must be restarted", async () => {
  const apply = vi.fn(async () => ({ applied: true, mode: "on" as const, model: "m", restarted: false }));
  const { findByTestId, getByRole } = setupApply(apply);
  await findByTestId("voice-effective");
  await fireEvent.click(getByRole("button", { name: "Apply to harness" }));
  expect((await findByTestId("voice-apply-result")).textContent).toMatch(
    /Applied — restart the gateway to pick it up/
  );
});

test("an apply failure is shown as the error", async () => {
  const apply = vi.fn(async () => {
    throw new Error("the transcription setting IS written to the profile, but the harness could not be restarted");
  });
  const { findByTestId, getByRole, findByRole } = setupApply(apply);
  await findByTestId("voice-effective");
  await fireEvent.click(getByRole("button", { name: "Apply to harness" }));
  const alert = await findByRole("alert");
  expect(alert.textContent).toMatch(/IS written/);
  // Ready to try again.
  await waitFor(() =>
    expect((getByRole("button", { name: "Apply to harness" }) as HTMLButtonElement).disabled).toBe(false)
  );
});

test("unsaved changes must be saved before applying", async () => {
  const apply = vi.fn();
  const { findByTestId, getByRole, getByLabelText } = setupApply(apply);
  await findByTestId("voice-effective");
  await fireEvent.click(getByLabelText("Off"));
  expect((getByRole("button", { name: "Apply to harness" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a bridge-mode station has no such note and no apply button", async () => {
  const { findByTestId, queryByTestId, queryByRole } = setup();
  await findByTestId("voice-effective");
  expect(queryByTestId("voice-harness-note")).toBeNull();
  expect(queryByRole("button", { name: "Apply to harness" })).toBeNull();
});
