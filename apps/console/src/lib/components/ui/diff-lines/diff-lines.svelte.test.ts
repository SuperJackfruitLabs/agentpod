import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { DiffLines } from "./index";

afterEach(() => cleanup());

test("added and removed lines are marked and drawn with the vibe's success and danger tokens", () => {
  const { container } = render(DiffLines, { props: { oldText: "a\nb\n", newText: "a\nc\n" } });
  const added = container.querySelector("[data-diff='added']")!;
  const removed = container.querySelector("[data-diff='removed']")!;
  expect(added.textContent).toContain("c");
  expect(removed.textContent).toContain("b");
  expect(container.querySelector("[data-diff='same']")!.textContent).toContain("a");
  expect(added.className).toMatch(/success/);
  expect(removed.className).toMatch(/danger|destructive/);
  expect(removed.className).toMatch(/line-through/);
  expect(container.innerHTML).not.toMatch(/green-|red-/);
});

test("a unified patch is drawn with the same marks: hunks, added, removed, context", () => {
  const { container } = render(DiffLines, { props: { patch: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n" } });
  expect(container.querySelector("[data-diff='hunk']")!.textContent).toContain("@@ -1,2 +1,2 @@");
  expect(container.querySelector("[data-diff='added']")!.textContent).toContain("+c");
  expect(container.querySelector("[data-diff='removed']")!.textContent).toContain("-b");
  expect(container.querySelector("[data-diff='same']")!.textContent).toContain(" a");
  expect(container.querySelector("[data-diff='added']")!.className).toMatch(/success/);
});
