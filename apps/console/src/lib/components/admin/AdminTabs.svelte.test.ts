/**
 * AdminTabs.svelte.test.ts
 *
 * Five sections do not fit a phone. The strip scrolls inside itself — at 390px
 * it used to widen <main> to 406px and pan the whole page — and keeps the
 * section you are on in view.
 */
import { test, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";
import AdminTabs from "./AdminTabs.svelte";

test("the strip scrolls in its own box, never the page", () => {
  const { getByRole } = render(AdminTabs, { active: "grants" });
  const nav = getByRole("navigation", { name: "Admin sections" });
  expect(nav.className).toContain("scroll-strip");
  expect(nav.className).toContain("min-w-0");
});

test("the current section is scrolled into view", () => {
  const scrolled: Element[] = [];
  const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolled.push(this);
  });
  const { getByRole } = render(AdminTabs, { active: "speech" });
  expect(scrolled).toContain(getByRole("link", { name: "Speech" }));
  spy.mockRestore();
});
