/**
 * scroll-strip.test.ts
 *
 * A horizontal strip (tabs, the attention lane) that is wider than its box
 * must say so, and must keep the selected item on screen. jsdom has no layout,
 * so the geometry is stubbed on the elements themselves.
 */
import { test, expect, vi, afterEach } from "vitest";
import { scrollStrip } from "./scroll-strip";

function strip(opts: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  const node = document.createElement("div");
  Object.defineProperty(node, "scrollWidth", { configurable: true, get: () => opts.scrollWidth });
  Object.defineProperty(node, "clientWidth", { configurable: true, get: () => opts.clientWidth });
  Object.defineProperty(node, "scrollLeft", {
    configurable: true,
    get: () => opts.scrollLeft ?? 0,
    set: (v: number) => (opts.scrollLeft = v),
  });
  document.body.appendChild(node);
  return node;
}

afterEach(() => {
  document.body.innerHTML = "";
});

test("a strip that fits says nothing more is there", () => {
  const node = strip({ scrollWidth: 300, clientWidth: 300 });
  const action = scrollStrip(node);
  expect(node.hasAttribute("data-more-start")).toBe(false);
  expect(node.hasAttribute("data-more-end")).toBe(false);
  action.destroy();
});

test("a strip wider than its box marks the end that has more, and follows the scroll", () => {
  const geom = { scrollWidth: 800, clientWidth: 300, scrollLeft: 0 };
  const node = strip(geom);
  const action = scrollStrip(node);
  expect(node.hasAttribute("data-more-end")).toBe(true);
  expect(node.hasAttribute("data-more-start")).toBe(false);

  geom.scrollLeft = 200;
  node.dispatchEvent(new Event("scroll"));
  expect(node.hasAttribute("data-more-start")).toBe(true);
  expect(node.hasAttribute("data-more-end")).toBe(true);

  geom.scrollLeft = 500;
  node.dispatchEvent(new Event("scroll"));
  expect(node.hasAttribute("data-more-start")).toBe(true);
  expect(node.hasAttribute("data-more-end")).toBe(false);
  action.destroy();
});

test("the selected item is scrolled into view on mount, and again when the selection changes", () => {
  const node = strip({ scrollWidth: 800, clientWidth: 300 });
  node.innerHTML = `<button role="tab" aria-selected="false">a</button><button role="tab" aria-selected="true">b</button>`;
  const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  const action = scrollStrip(node, "b");
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.instances[0]).toBe(node.children[1]);
  // Only the strip may move: never yank the page vertically to reach a tab.
  expect(spy.mock.calls[0][0]).toMatchObject({ block: "nearest", inline: "nearest" });

  node.children[1].setAttribute("aria-selected", "false");
  node.children[0].setAttribute("aria-selected", "true");
  action.update("a");
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.instances[1]).toBe(node.children[0]);
  spy.mockRestore();
  action.destroy();
});

test("an aria-current link counts as the selected item", () => {
  const node = strip({ scrollWidth: 800, clientWidth: 300 });
  node.innerHTML = `<a href="/a">a</a><a href="/b" aria-current="page">b</a>`;
  const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  const action = scrollStrip(node, "b");
  expect(spy.mock.instances[0]).toBe(node.children[1]);
  spy.mockRestore();
  action.destroy();
});
