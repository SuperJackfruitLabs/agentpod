/**
 * Test helpers for the phone pass.
 *
 * jsdom does no layout, so these check what it CAN tell: the viewport the
 * components were told about (matchMedia, innerWidth), fixed widths written
 * into class names and inline styles, and the card-table contract. The real
 * scrollWidth check runs in the Playwright sweep (e2e/sweep.spec.ts).
 */
import { expect } from "vitest";
import { BREAKPOINTS } from "$lib/breakpoints";

/** Answer matchMedia and innerWidth as a viewport `width` px wide. Returns a restore function. */
export function setViewport(width: number): () => void {
  const realMatchMedia = window.matchMedia;
  const realWidth = window.innerWidth;
  window.matchMedia = ((query: string) => {
    const max = /\(max-width:\s*(\d+)px\)/.exec(query);
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    // A fine pointer: `(pointer: coarse)` and anything else unknown is false.
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return {
      matches, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  return () => {
    window.matchMedia = realMatchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: realWidth });
  };
}

/** Something that scrolls sideways on purpose: what is inside may be wider. */
function inScroller(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const c = p.classList;
    if (c.contains("overflow-x-auto") || c.contains("overflow-auto") || c.contains("overflow-x-scroll") || c.contains("scroll-strip") || c.contains("ap-tbl-wrap")) return true;
  }
  return false;
}

/**
 * Fixed widths that would push past a `width` px viewport, outside a sideways
 * scroller. A card table's own min-width is cancelled below the cards
 * breakpoint, so it does not count there. Returns "tag.class: Npx" strings.
 */
export function overflowingElements(root: ParentNode, width: number): string[] {
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (width <= BREAKPOINTS.cards && el.classList.contains("ap-tbl--cards")) continue;
    const fixed: number[] = [];
    for (const m of (el.getAttribute("class") ?? "").matchAll(/(?:^|\s)(?:[a-z-]+:)*(?:min-w|w)-\[(\d+)px\]/g)) fixed.push(Number(m[1]));
    for (const m of (el.getAttribute("style") ?? "").matchAll(/(?:^|;)\s*(?:min-)?width:\s*(\d+)px/g)) fixed.push(Number(m[1]));
    const widest = Math.max(0, ...fixed);
    if (widest > width && !inScroller(el)) out.push(`${el.tagName.toLowerCase()}.${el.className}: ${widest}px`);
  }
  return out;
}

/** Fails the test when anything in `root` would widen a `width` px page. */
export function expectNoOverflow(root: ParentNode, width: number) {
  expect(overflowingElements(root, width)).toEqual([]);
}

/**
 * A table that turns into cards under 768px: marked `.ap-tbl--cards`, and every
 * cell of a data row says what it is on a card: a `data-label` line, or a
 * `data-card` role (title, status, actions, hide). One title per row.
 */
export function expectCardTable(table: Element | null, rowSelector = "tbody tr") {
  expect(table, "table").not.toBeNull();
  expect(table!.classList.contains("ap-tbl--cards")).toBe(true);
  const rows = Array.from(table!.querySelectorAll(rowSelector));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const cells = Array.from(row.children);
    if (cells.length === 1 && cells[0]!.hasAttribute("colspan")) continue;
    const bare = cells.filter((c) => !c.hasAttribute("data-label") && !c.hasAttribute("data-card"));
    expect(bare.map((c) => c.outerHTML.slice(0, 80))).toEqual([]);
    expect(cells.filter((c) => c.getAttribute("data-card") === "title").length).toBe(1);
  }
}
