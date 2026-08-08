import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup, within } from "@testing-library/svelte";
import * as api from "$lib/api/client";

// Mock the MonacoEditor with a textarea stub so jsdom tests can drive the buffer.
// The stub renders a plain textarea that calls onchange on input — matching
// the interface expected by ConfigEditor.
vi.mock("$lib/components/ui/monaco-editor", async () => {
  const { default: MonacoEditorStub } = await import(
    "../ui/monaco-editor/monaco-editor.stub.svelte"
  );
  return { MonacoEditor: MonacoEditorStub };
});

// Static import so Svelte compiles the component during file collection,
// avoiding a long compilation delay inside the first waitFor window.
import ConfigEditor from "./ConfigEditor.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

test("ConfigEditor: loads file content into editor and Save is disabled when unchanged", async () => {
  vi.spyOn(api, "readFile").mockResolvedValue({ content: "line1\nline2\n", truncated: false });

  const { getByRole } = render(ConfigEditor, {
    props: { stationId: "station_1", path: "config.yaml" },
  });

  await waitFor(() => {
    const textarea = getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("line1\nline2\n");
  });

  expect(api.readFile).toHaveBeenCalledWith("station_1", "config.yaml");

  const saveBtn = getByRole("button", { name: /save/i }) as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(true);
});

test("ConfigEditor: editing buffer shows a diff and enables Save", async () => {
  vi.spyOn(api, "readFile").mockResolvedValue({ content: "line1\nline2\n", truncated: false });

  const { getByRole, container } = render(ConfigEditor, {
    props: { stationId: "station_1", path: "config.yaml" },
  });

  await waitFor(() => expect((getByRole("textbox") as HTMLTextAreaElement).value).toBe("line1\nline2\n"));

  const textarea = getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.input(textarea, { target: { value: "line1\nCHANGED\n" } });

  await waitFor(() => {
    // The diff view renders the changed line — check it appears in the rendered diff section.
    const diffView = container.querySelector("[data-testid='diff-view']");
    expect(diffView).toBeTruthy();
    expect(diffView!.textContent).toContain("CHANGED");
    const saveBtn = getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });
});

test("ConfigEditor: Save opens ConfirmDialog and writeFile is called with backup:true on confirm", async () => {
  vi.spyOn(api, "readFile").mockResolvedValue({ content: "line1\nline2\n", truncated: false });
  vi.spyOn(api, "writeFile").mockResolvedValue({ bytesWritten: 15, backupPath: "config.yaml.2026.bak" });

  const { getByRole } = render(ConfigEditor, {
    props: { stationId: "station_1", path: "config.yaml" },
  });

  await waitFor(() => expect((getByRole("textbox") as HTMLTextAreaElement).value).toBe("line1\nline2\n"));

  // Edit the buffer
  const textarea = getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.input(textarea, { target: { value: "line1\nCHANGED\n" } });

  await waitFor(() => {
    const saveBtn = getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  // Click Save → ConfirmDialog opens
  fireEvent.click(getByRole("button", { name: /save/i }));

  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());

  // Confirm the save
  fireEvent.click(within(getByRole("dialog")).getByRole("button", { name: "Save changes" }));

  await waitFor(() => {
    expect(api.writeFile).toHaveBeenCalledWith(
      "station_1",
      "config.yaml",
      "line1\nCHANGED\n",
      { backup: true }
    );
  });
});

test("ConfigEditor: after save, original is updated and Save becomes disabled again", async () => {
  vi.spyOn(api, "readFile").mockResolvedValue({ content: "line1\nline2\n", truncated: false });
  vi.spyOn(api, "writeFile").mockResolvedValue({ bytesWritten: 15, backupPath: null });

  const { getByRole } = render(ConfigEditor, {
    props: { stationId: "station_1", path: "config.yaml" },
  });

  await waitFor(() => expect((getByRole("textbox") as HTMLTextAreaElement).value).toBe("line1\nline2\n"));

  fireEvent.input(getByRole("textbox"), { target: { value: "line1\nNEW\n" } });

  await waitFor(() => {
    expect((getByRole("button", { name: /save/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  fireEvent.click(getByRole("button", { name: /save/i }));
  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());
  fireEvent.click(within(getByRole("dialog")).getByRole("button", { name: "Save changes" }));

  // After save, buffer === original → Save disabled again
  await waitFor(() => {
    expect((getByRole("button", { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
