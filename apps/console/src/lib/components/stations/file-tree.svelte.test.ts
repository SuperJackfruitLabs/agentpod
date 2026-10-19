import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup, within } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import type { FsEntry } from "@agentpod/contract";

vi.mock("svelte-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import FileTree from "./file-tree.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const e = (path: string, type: "dir" | "file"): FsEntry => ({
  name: path.split("/").pop()!,
  path,
  type,
  size: type === "dir" ? null : 10,
  modified: null,
});

function stubFs() {
  vi.spyOn(api, "listFiles").mockImplementation(async (_s: string, path: string) => {
    if (path === "") return [e("src", "dir"), e("README.md", "file"), e("package.json", "file")];
    if (path === "src") return [e("src/index.ts", "file"), e("src/lib", "dir")];
    return [];
  });
}

async function mount(props: Record<string, unknown> = {}) {
  stubFs();
  const onEntryClick = vi.fn();
  const r = render(FileTree, { props: { stationId: "s1", activePath: null, onEntryClick, ...props } });
  const tree = await waitFor(() => r.getByRole("tree"));
  return { ...r, tree, onEntryClick };
}

test("the file list is a tree: treeitems with levels, folders expose aria-expanded, children sit in a group", async () => {
  const { tree, getByRole } = await mount();
  const items = within(tree).getAllByRole("treeitem");
  expect(items.map((i) => i.getAttribute("data-tree-path"))).toEqual(["src", "package.json", "README.md"]);
  const src = getByRole("treeitem", { name: "src" });
  expect(src.getAttribute("aria-expanded")).toBe("false");
  expect(src.getAttribute("aria-level")).toBe("1");
  expect(getByRole("treeitem", { name: "README.md" }).hasAttribute("aria-expanded")).toBe(false);

  await fireEvent.click(within(src).getByText("src"));
  await waitFor(() => expect(src.getAttribute("aria-expanded")).toBe("true"));
  const group = within(src).getByRole("group");
  const child = within(group).getByRole("treeitem", { name: "index.ts" });
  expect(child.getAttribute("aria-level")).toBe("2");
});

test("one treeitem is in the tab order; arrows, Home and End move focus; Right/Left open and close folders", async () => {
  const { tree, getByRole, onEntryClick } = await mount();
  const src = getByRole("treeitem", { name: "src" });
  const readme = getByRole("treeitem", { name: "README.md" });
  const pkg = getByRole("treeitem", { name: "package.json" });
  expect(src.tabIndex).toBe(0);
  expect(readme.tabIndex).toBe(-1);

  src.focus();
  await fireEvent.keyDown(src, { key: "ArrowDown" });
  expect(document.activeElement).toBe(pkg);
  await fireEvent.keyDown(pkg, { key: "End" });
  expect(document.activeElement).toBe(readme);
  await fireEvent.keyDown(readme, { key: "ArrowUp" });
  expect(document.activeElement).toBe(pkg);
  await fireEvent.keyDown(pkg, { key: "Home" });
  expect(document.activeElement).toBe(src);

  await fireEvent.keyDown(src, { key: "ArrowRight" });
  await waitFor(() => expect(src.getAttribute("aria-expanded")).toBe("true"));
  await fireEvent.keyDown(src, { key: "ArrowRight" });
  const lib = getByRole("treeitem", { name: "lib" }); // folders sort first
  expect(document.activeElement).toBe(lib);
  await fireEvent.keyDown(lib, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(src);
  await fireEvent.keyDown(src, { key: "ArrowLeft" });
  await waitFor(() => expect(src.getAttribute("aria-expanded")).toBe("false"));

  readme.focus();
  await fireEvent.keyDown(readme, { key: "Enter" });
  expect(onEntryClick).toHaveBeenCalledWith(expect.objectContaining({ path: "README.md" }));
  expect(tree.contains(document.activeElement)).toBe(true);
});

test("the open file is the selected treeitem", async () => {
  const { getByRole } = await mount({ activePath: "README.md" });
  expect(getByRole("treeitem", { name: "README.md" }).getAttribute("aria-selected")).toBe("true");
  expect(getByRole("treeitem", { name: "package.json" }).getAttribute("aria-selected")).toBe("false");
});

test("rename and delete are visible and 44px on a touch screen (they were hover-only)", async () => {
  const { getByRole } = await mount({ canWrite: true });
  for (const name of ["Rename README.md", "Delete README.md"]) {
    const cls = getByRole("button", { name }).className;
    expect(cls).toContain("pointer-coarse:opacity-100");
    expect(cls).toContain("pointer-coarse:size-11");
  }
});
