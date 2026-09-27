/**
 * Admin → Transcription: the hub's default speech-to-text service.
 *
 * What this form must never do is echo an API key it cannot see. The hub
 * answers `hasApiKey`, and a save must say keep / clear / replace without
 * the console ever holding the saved key — so each of the three is asserted
 * against the body that would be sent.
 */

import { test, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("svelte-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import HubTranscriptionSettings from "./HubTranscriptionSettings.svelte";
import type { HubTranscription, HubTranscriptionInput } from "$lib/api/transcription";

const FROM_ENV: HubTranscription = {
  enabled: true,
  url: "http://100.78.52.87:8840",
  model: "large-v3-turbo",
  maxSeconds: 300,
  hasApiKey: true,
  source: "env",
};

function setup(initial: HubTranscription = FROM_ENV) {
  const load = vi.fn(async () => initial);
  const save = vi.fn(async (input: HubTranscriptionInput): Promise<HubTranscription> => ({
    ...initial,
    ...input,
    hasApiKey: input.apiKey === undefined ? initial.hasApiKey : typeof input.apiKey === "string",
    source: "settings" as const,
  }));
  const testConnection = vi.fn(async () => ({ ok: true, status: 200, elapsedMs: 412 }));
  const r = render(HubTranscriptionSettings, { load, save, testConnection });
  return { ...r, load, save, testConnection };
}

test("shows where the current config comes from, and a saved key only as saved", async () => {
  const { findByText, getByTestId, queryByDisplayValue } = setup();
  await findByText(/From the hub's environment/);
  expect(getByTestId("api-key-saved").textContent).toContain("•••• saved");
  expect((document.getElementById("hub-transcription-url") as HTMLInputElement).value).toBe("http://100.78.52.87:8840");
  // Nothing on the page is a key.
  expect(queryByDisplayValue(/sk-/)).toBeNull();
});

test("saving without touching the key keeps it: the key is not in the body at all", async () => {
  const { findByText, getByRole, save } = setup();
  await findByText(/From the hub's environment/);
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const body = save.mock.calls[0]![0] as unknown as Record<string, unknown>;
  expect("apiKey" in body && body.apiKey !== undefined).toBe(false);
  expect(body).toMatchObject({ enabled: true, url: "http://100.78.52.87:8840", model: "large-v3-turbo", maxSeconds: 300 });
});

test("Clear sends null, and Undo takes it back before a save", async () => {
  const { findByText, getByRole, getByTestId, save } = setup();
  await findByText(/From the hub's environment/);

  await fireEvent.click(getByRole("button", { name: "Clear" }));
  expect(getByTestId("api-key-cleared")).toBeTruthy();
  await fireEvent.click(getByRole("button", { name: "Undo" }));
  expect(getByTestId("api-key-saved")).toBeTruthy();

  await fireEvent.click(getByRole("button", { name: "Clear" }));
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0]).toMatchObject({ apiKey: null });
});

test("Replace sends the new key, typed into a password box", async () => {
  const { findByText, getByRole, save } = setup();
  await findByText(/From the hub's environment/);

  await fireEvent.click(getByRole("button", { name: "Replace" }));
  const keyInput = document.getElementById("hub-transcription-key") as HTMLInputElement;
  expect(keyInput.type).toBe("password");
  await fireEvent.input(keyInput, { target: { value: "sk-test-new" } });
  await fireEvent.click(getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0]).toMatchObject({ apiKey: "sk-test-new" });
});

test("choosing a provider fills its URL and model", async () => {
  const { findByText, getByLabelText } = setup();
  await findByText(/From the hub's environment/);
  await fireEvent.change(getByLabelText("Provider"), { target: { value: "groq" } });
  expect((document.getElementById("hub-transcription-url") as HTMLInputElement).value).toBe("https://api.groq.com/openai");
  expect((document.getElementById("hub-transcription-model") as HTMLInputElement).value).toBe("whisper-large-v3-turbo");

  await fireEvent.change(getByLabelText("Provider"), { target: { value: "openai" } });
  expect((document.getElementById("hub-transcription-url") as HTMLInputElement).value).toBe("https://api.openai.com");
  expect((document.getElementById("hub-transcription-model") as HTMLInputElement).value).toBe("whisper-1");
});

test("a URL that is not http(s) blocks the save", async () => {
  const { findByText, getByRole } = setup();
  await findByText(/From the hub's environment/);
  const url = document.getElementById("hub-transcription-url") as HTMLInputElement;
  await fireEvent.input(url, { target: { value: "ftp://nope" } });
  await findByText(/http:\/\/ or https:\/\//);
  expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});

test("Test connection sends what is typed and shows the answer", async () => {
  const { findByText, getByRole, testConnection } = setup();
  await findByText(/From the hub's environment/);
  await fireEvent.click(getByRole("button", { name: "Test connection" }));
  await findByText(/Connected/);
  expect(testConnection).toHaveBeenCalledWith({ url: "http://100.78.52.87:8840", model: "large-v3-turbo" });

  testConnection.mockResolvedValueOnce({ ok: false, status: 401, error: "the transcription service answered 401: bad key", elapsedMs: 90 } as never);
  await fireEvent.click(getByRole("button", { name: "Test connection" }));
  await findByText(/answered 401: bad key/);
});
