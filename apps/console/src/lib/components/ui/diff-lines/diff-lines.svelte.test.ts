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
