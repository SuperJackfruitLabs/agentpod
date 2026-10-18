import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";

const m = vi.hoisted(() => ({
  defineTheme: vi.fn(),
  setTheme: vi.fn(),
  create: vi.fn(),
}));

vi.mock("monaco-editor", () => ({
  KeyMod: { CtrlCmd: 1 },
  KeyCode: { KeyS: 2 },
  editor: {
    defineTheme: m.defineTheme,
    setTheme: m.setTheme,
    setModelLanguage: vi.fn(),
    create: m.create.mockImplementation(() => ({
      onDidChangeModelContent() {},
      addCommand() {},
      getValue: () => "",
      setValue() {},
      getModel: () => null,
      updateOptions() {},
      dispose() {},
    })),
  },
}));

vi.mock("$lib/utils/vk-colors", async (orig) => ({
  ...(await orig<typeof import("$lib/utils/vk-colors")>()),
  monacoTheme: () => ({ base: "vs", inherit: true, rules: [], colors: { tag: document.documentElement.dataset.theme } }),
}));

import MonacoEditor from "./monaco-editor.svelte";

afterEach(() => cleanup());

test("the editor uses a theme defined from the vibe's tokens and redefines it when the appearance changes", async () => {
  const html = document.documentElement;
  html.setAttribute("data-theme", "light");
  render(MonacoEditor, { props: { code: "x" } });
  await waitFor(() => expect(m.create).toHaveBeenCalled());
  expect(m.create.mock.calls[0][1].theme).toBe("agentpod-vibe");
  expect(m.defineTheme).toHaveBeenLastCalledWith("agentpod-vibe", expect.objectContaining({ colors: { tag: "light" } }));

  m.setTheme.mockClear();
  html.setAttribute("data-theme", "dark");
  await waitFor(() =>
    expect(m.defineTheme).toHaveBeenLastCalledWith("agentpod-vibe", expect.objectContaining({ colors: { tag: "dark" } })),
  );
  expect(m.setTheme).toHaveBeenCalledWith("agentpod-vibe");
});
