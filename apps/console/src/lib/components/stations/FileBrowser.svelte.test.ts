import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup, within } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import type { FsEntry } from "@agentpod/contract";

// Mock MonacoEditor with a textarea stub so jsdom tests can read its value —
// same pattern as ConfigEditor.svelte.test.ts.
vi.mock("$lib/components/ui/monaco-editor", async () => {
  const { default: MonacoEditorStub } = await import(
    "../ui/monaco-editor/monaco-editor.stub.svelte"
  );
  return { MonacoEditor: MonacoEditorStub };
});

// Mock MarkdownViewer: shiki-backed rendering doesn't run reliably in jsdom.
vi.mock("$lib/components/ui/markdown", async () => {
  const { default: MarkdownViewerStub } = await import(
    "../ui/markdown/markdown-viewer.stub.svelte"
  );
  return { MarkdownViewer: MarkdownViewerStub };
});

// Static import ensures module is compiled during file collection, so the
// first test doesn't pay the ~4s compilation cost inside its waitFor window.
import FileBrowser from "./FileBrowser.svelte";


beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const mockDir: FsEntry = {
  name: "src",
  path: "src",
  type: "dir",
  size: null,
  modified: null,
};

const mockFile: FsEntry = {
  name: "README.md",
  path: "README.md",
  type: "file",
  size: 1024,
  modified: "2026-06-27T10:00:00Z",
};

const mockSubFile: FsEntry = {
  name: "index.ts",
  path: "src/index.ts",
  type: "file",
  size: 512,
  modified: "2026-06-27T09:00:00Z",
};

const mockLogo: FsEntry = {
  name: "logo.png",
  path: "logo.png",
  type: "file",
  size: 2048,
  modified: "2026-06-27T08:00:00Z",
};

test("FileBrowser renders root entries (dir + file)", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockDir, mockFile]);

  const { getByText } = render(FileBrowser, { props: { stationId: "station_1" } });

  await waitFor(() => {
    expect(getByText("src")).toBeTruthy();
    expect(getByText("README.md")).toBeTruthy();
  });

  expect(api.listFiles).toHaveBeenCalledWith("station_1", "");
});

test("FileBrowser clicking a directory calls listFiles again for that path", async () => {
  vi.spyOn(api, "listFiles")
    .mockResolvedValueOnce([mockDir, mockFile])   // root load
    .mockResolvedValueOnce([mockSubFile]);         // dir expand load

  const { getByText } = render(FileBrowser, { props: { stationId: "station_1" } });

  await waitFor(() => expect(getByText("src")).toBeTruthy());

  // Click the directory to trigger lazy load
  fireEvent.click(getByText("src"));

  await waitFor(() => {
    expect(api.listFiles).toHaveBeenCalledWith("station_1", "src");
    expect(getByText("index.ts")).toBeTruthy();
  });
});

test("FileBrowser clicking a file calls readFile", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockDir, mockFile]);
  vi.spyOn(api, "readFile").mockResolvedValue({ content: "# Hello", truncated: false });

  const { getByText } = render(FileBrowser, { props: { stationId: "station_1" } });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());

  fireEvent.click(getByText("README.md"));

  await waitFor(() => {
    expect(api.readFile).toHaveBeenCalledWith("station_1", "README.md");
  });
});

test("FileBrowser shows truncated notice when file is truncated", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockFile]);
  vi.spyOn(api, "readFile").mockResolvedValue({ content: "big content...", truncated: true });

  const { getByText } = render(FileBrowser, { props: { stationId: "station_1" } });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());
  fireEvent.click(getByText("README.md"));

  await waitFor(() => {
    expect(getByText(/truncated/i)).toBeTruthy();
  });
});

// ─── Write-action tests (canWrite=true) ──────────────────────────────────────

test("FileBrowser: delete button opens type-to-confirm dialog and calls del on confirm", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockFile]);
  vi.spyOn(api, "del").mockResolvedValue({ ok: true });

  const { getByText, getByRole } = render(FileBrowser, {
    props: { stationId: "station_1", canWrite: true },
  });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());

  // Click the delete button for README.md
  fireEvent.click(getByRole("button", { name: "Delete README.md" }));

  // The type-to-confirm dialog should now be open
  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());

  // Type the confirm phrase (the file name)
  const input = within(getByRole("dialog")).getByRole("textbox");
  fireEvent.input(input, { target: { value: "README.md" } });

  // Confirm button should now be enabled — labeled with the action
  await waitFor(() => {
    const btn = getByRole("button", { name: "Delete file" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  fireEvent.click(getByRole("button", { name: "Delete file" }));

  await waitFor(() => {
    expect(api.del).toHaveBeenCalledWith("station_1", "README.md", { recursive: false });
  });
});

test("FileBrowser: new folder button calls mkdir", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([]);
  vi.spyOn(api, "mkdir").mockResolvedValue({ ok: true });

  const { getByRole, getByPlaceholderText } = render(FileBrowser, {
    props: { stationId: "station_1", canWrite: true },
  });

  // Toolbar is rendered immediately (outside the loading state block)
  const newFolderBtn = getByRole("button", { name: /new folder/i });
  fireEvent.click(newFolderBtn);

  // An inline name input should appear
  await waitFor(() => {
    expect(getByPlaceholderText(/folder name/i)).toBeTruthy();
  });

  const input = getByPlaceholderText(/folder name/i);
  fireEvent.input(input, { target: { value: "my-new-dir" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(api.mkdir).toHaveBeenCalledWith("station_1", "my-new-dir");
  });
});

test("FileBrowser: 'Edit' button calls onOpenConfigEditor with the file path", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockFile]);
  vi.spyOn(api, "readFile").mockResolvedValue({ content: "# Hello", truncated: false });

  const onOpenConfigEditor = vi.fn();

  const { getByText, getByRole } = render(FileBrowser, {
    props: { stationId: "station_1", canWrite: true, onOpenConfigEditor },
  });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());

  // Click the file to open the preview
  fireEvent.click(getByText("README.md"));

  // Wait for file content to load and "Edit" to appear
  await waitFor(() => {
    expect(getByRole("button", { name: /^edit$/i })).toBeTruthy();
  });

  fireEvent.click(getByRole("button", { name: /^edit$/i }));

  expect(onOpenConfigEditor).toHaveBeenCalledWith("README.md");
});

test("FileBrowser: write actions are hidden when canWrite is false", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockFile]);

  const { queryByRole, getByText } = render(FileBrowser, {
    props: { stationId: "station_1", canWrite: false },
  });

  // Wait for entries to render
  await waitFor(() => expect(getByText("README.md")).toBeTruthy());

  // Toolbar and per-entry write actions must not exist
  expect(queryByRole("button", { name: /new file/i })).toBeNull();
  expect(queryByRole("button", { name: /new folder/i })).toBeNull();
  expect(queryByRole("button", { name: "Delete README.md" })).toBeNull();
  expect(queryByRole("button", { name: "Rename README.md" })).toBeNull();
});

// ─── Tabs / preview rebuild tests ────────────────────────────────────────────

test("FileBrowser: opens multiple files as tabs and switches between them without refetching", async () => {
  vi.spyOn(api, "listFiles")
    .mockResolvedValueOnce([mockDir, mockFile]) // root load
    .mockResolvedValueOnce([mockSubFile]); // src/ expand load
  vi.spyOn(api, "readFile")
    .mockResolvedValueOnce({ content: "# Hello", truncated: false }) // README.md
    .mockResolvedValueOnce({ content: "export const x = 1;", truncated: false }); // src/index.ts

  const { getByText, getByRole } = render(FileBrowser, { props: { stationId: "station_1" } });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());
  fireEvent.click(getByText("README.md"));
  await waitFor(() => expect(getByRole("tab", { name: "README.md" })).toBeTruthy());

  fireEvent.click(getByText("src"));
  await waitFor(() => expect(getByText("index.ts")).toBeTruthy());
  fireEvent.click(getByText("index.ts"));
  await waitFor(() => expect(getByRole("tab", { name: "index.ts" })).toBeTruthy());

  // Two files opened → two readFile calls, one per file.
  expect(api.readFile).toHaveBeenCalledTimes(2);

  // Switch back to the first tab: its content is shown again with no extra fetch.
  fireEvent.click(getByRole("tab", { name: "README.md" }));
  await waitFor(() => {
    expect(getByRole("tab", { name: "README.md" }).getAttribute("aria-selected")).toBe("true");
  });
  expect(api.readFile).toHaveBeenCalledTimes(2);
});

test("FileBrowser: renders markdown files with a Rendered/Source toggle", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockFile]);
  vi.spyOn(api, "readFile").mockResolvedValue({ content: "# Hello world", truncated: false });

  const { getByText, getByRole, container } = render(FileBrowser, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());
  fireEvent.click(getByText("README.md"));

  // Default view is Rendered → the mocked MarkdownViewer output is visible.
  await waitFor(() => {
    const stub = container.querySelector('[data-testid="markdown-viewer-stub"]');
    expect(stub).toBeTruthy();
    expect(stub!.textContent).toContain("# Hello world");
  });

  fireEvent.click(getByRole("button", { name: /^source$/i }));

  // Source view swaps in the mocked Monaco editor with the same content.
  await waitFor(() => {
    const textarea = getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Hello world");
  });
});

test("FileBrowser: shows a metadata card instead of fetching binary files", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockLogo]);
  const readFileSpy = vi.spyOn(api, "readFile");

  const { getByText } = render(FileBrowser, { props: { stationId: "station_1" } });

  await waitFor(() => expect(getByText("logo.png")).toBeTruthy());
  fireEvent.click(getByText("logo.png"));

  await waitFor(() => {
    expect(getByText(/can’t preview this file type/i)).toBeTruthy();
  });
  expect(readFileSpy).not.toHaveBeenCalled();
  // 2048 bytes → "2.0 KB" via the metadata card's size formatting.
  expect(getByText(/2\.0 KB/)).toBeTruthy();
});

// ─── Cache invalidation (ConfigEditor save → FileBrowser refetch) ───────────

test("FileBrowser: invalidate() evicts the cache and refetches when the path is the active tab", async () => {
  vi.spyOn(api, "listFiles").mockResolvedValue([mockFile]);
  vi.spyOn(api, "readFile")
    .mockResolvedValueOnce({ content: "# Hello", truncated: false }) // initial open
    .mockResolvedValueOnce({ content: "# Hello, edited", truncated: false }); // post-save refetch

  const { getByText, component } = render(FileBrowser, {
    props: { stationId: "station_1", canWrite: true },
  });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());
  fireEvent.click(getByText("README.md"));

  await waitFor(() => {
    expect(getByText("# Hello")).toBeTruthy();
  });
  expect(api.readFile).toHaveBeenCalledTimes(1);

  // Simulate ConfigEditor's onSaved firing for the file that's currently
  // the active tab — mirrors the station page's
  // `onSaved={(p) => fileBrowser?.invalidate(p)}` wiring.
  component.invalidate("README.md");

  await waitFor(() => {
    expect(api.readFile).toHaveBeenCalledTimes(2);
    expect(getByText("# Hello, edited")).toBeTruthy();
  });
});

test("FileBrowser: invalidate() on a non-active path evicts the cache without refetching", async () => {
  vi.spyOn(api, "listFiles")
    .mockResolvedValueOnce([mockDir, mockFile])
    .mockResolvedValueOnce([mockSubFile]);
  vi.spyOn(api, "readFile")
    .mockResolvedValueOnce({ content: "# Hello", truncated: false }) // README.md
    .mockResolvedValueOnce({ content: "export const x = 1;", truncated: false }); // src/index.ts

  const { getByText, getByRole, component } = render(FileBrowser, {
    props: { stationId: "station_1", canWrite: true },
  });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());
  fireEvent.click(getByText("README.md"));
  await waitFor(() => expect(getByRole("tab", { name: "README.md" })).toBeTruthy());

  fireEvent.click(getByText("src"));
  await waitFor(() => expect(getByText("index.ts")).toBeTruthy());
  fireEvent.click(getByText("index.ts"));
  await waitFor(() => expect(getByRole("tab", { name: "index.ts" })).toBeTruthy());

  expect(api.readFile).toHaveBeenCalledTimes(2);

  // README.md was edited elsewhere but isn't the active tab (index.ts is) —
  // its cache entry is evicted but no refetch happens until it's reopened.
  component.invalidate("README.md");
  expect(api.readFile).toHaveBeenCalledTimes(2);

  fireEvent.click(getByRole("tab", { name: "README.md" }));
  await waitFor(() => expect(api.readFile).toHaveBeenCalledTimes(3));
});

test("FileBrowser: closes a tab with its close button", async () => {
  vi.spyOn(api, "listFiles")
    .mockResolvedValueOnce([mockDir, mockFile])
    .mockResolvedValueOnce([mockSubFile]);
  vi.spyOn(api, "readFile")
    .mockResolvedValueOnce({ content: "# Hello", truncated: false })
    .mockResolvedValueOnce({ content: "export const x = 1;", truncated: false });

  const { getByText, getByRole, queryByRole } = render(FileBrowser, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => expect(getByText("README.md")).toBeTruthy());
  fireEvent.click(getByText("README.md"));
  await waitFor(() => expect(getByRole("tab", { name: "README.md" })).toBeTruthy());

  fireEvent.click(getByText("src"));
  await waitFor(() => expect(getByText("index.ts")).toBeTruthy());
  fireEvent.click(getByText("index.ts"));
  await waitFor(() => expect(getByRole("tab", { name: "index.ts" })).toBeTruthy());

  fireEvent.click(getByRole("button", { name: "Close README.md" }));

  await waitFor(() => {
    expect(queryByRole("tab", { name: "README.md" })).toBeNull();
    expect(getByRole("tab", { name: "index.ts" })).toBeTruthy();
  });
  expect(getByRole("tab", { name: "index.ts" }).getAttribute("aria-selected")).toBe("true");
});

test("a read-only viewer can still refresh the file list", async () => {
  // The file list is a cached view of a machine an agent is actively changing.
  // Before this, a file the agent created only appeared after a full page
  // reload, and the toolbar holding the action was gated behind canWrite.
  const spy = vi.spyOn(api, "listFiles").mockResolvedValue([mockDir, mockFile]);

  const { getByRole } = render(FileBrowser, {
    props: { stationId: "station_1", canWrite: false },
  });

  await waitFor(() => expect(spy).toHaveBeenCalledWith("station_1", ""));
  const callsBefore = spy.mock.calls.length;

  await fireEvent.click(getByRole("button", { name: /refresh file list/i }));

  await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(callsBefore));
});

test("refresh re-reads folders that are already expanded", async () => {
  // Reloading only the root would leave a file the agent created inside an
  // expanded folder invisible, because that folder's contents are cached.
  // Per-path, not a blanket mock: returning the same dir for every path makes
  // mockDir contain itself and the tree recurses forever.
  const child: FsEntry = {
    name: "child.txt",
    path: `${mockDir.path}/child.txt`,
    type: "file",
    size: 3,
    modified: null,
  };
  const spy = vi
    .spyOn(api, "listFiles")
    .mockImplementation(async (_id: string, path: string) =>
      path === "" ? [mockDir, mockFile] : [child],
    );

  const { getByRole, getByText } = render(FileBrowser, {
    props: { stationId: "station_1", canWrite: false },
  });

  await waitFor(() => expect(getByText(mockDir.name)).toBeTruthy());
  await fireEvent.click(getByText(mockDir.name));
  await waitFor(() => expect(spy).toHaveBeenCalledWith("station_1", mockDir.path));

  spy.mockClear();
  await fireEvent.click(getByRole("button", { name: /refresh file list/i }));

  await waitFor(() => {
    expect(spy).toHaveBeenCalledWith("station_1", "");
    expect(spy).toHaveBeenCalledWith("station_1", mockDir.path);
  });
});

// --- the phone layout -------------------------------------------------------
//
// Reported from a real phone: the Files tab rendered a column of anonymous
// folder icons with every filename clipped away. The pane split is horizontal
// (28% / 72%), so at 414px the tree resolved to ~110px — a chevron, an icon,
// and nothing else. Below the split's usable width there is ONE pane.

function narrowViewport() {
  // jsdom has no layout, so the component reads matchMedia rather than a width.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, // "(min-width: 701px)" does NOT match => phone
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

test("on a phone the tree gets the whole width instead of a 110px sliver", async () => {
  narrowViewport();
  const { findByTestId, queryByTestId } = render(FileBrowser, { stationId: "st_1", canWrite: true });

  expect(await findByTestId("file-browser-tree-only")).toBeTruthy();
  expect(queryByTestId("file-browser-file-only")).toBeNull();
});

test("on a phone the empty preview does not tell you to press a key you do not have", async () => {
  narrowViewport();
  const { findByTestId } = render(FileBrowser, { stationId: "st_1", canWrite: true });

  const tree = await findByTestId("file-browser-tree-only");
  expect(tree.ownerDocument.body.textContent).not.toContain("⌘P");
});
