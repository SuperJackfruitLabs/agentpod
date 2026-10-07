/**
 * scroll-strip — for a horizontal strip that may be wider than its box.
 *
 * Two jobs, both measured as missing on a 390px phone (responsive audit,
 * 2026-10-07): a tab strip showed four and a half tabs with nothing to say
 * five more existed, and a deep link to a later tab opened with the selected
 * tab off screen.
 *
 *  - Marks `data-more-start` / `data-more-end` on the strip while there is
 *    hidden content on that side. The `scroll-strip` class in app.css turns
 *    those into a fade, so the cut-off edge reads as "keep going".
 *  - Scrolls the selected item (`aria-selected="true"` or `aria-current`) into
 *    view on mount and whenever the parameter changes. Pass the active id as
 *    the parameter so Svelte calls `update` when the selection moves.
 *
 * `block: "nearest"` is load-bearing: the strip sits in a page that scrolls
 * vertically, and the default (`start`) would yank that page to the strip.
 */
export function scrollStrip(node: HTMLElement, active?: unknown) {
  function measure() {
    const max = node.scrollWidth - node.clientWidth;
    // 1px of slack: fractional widths leave a sub-pixel "overflow" at rest.
    node.toggleAttribute("data-more-start", max > 1 && node.scrollLeft > 1);
    node.toggleAttribute("data-more-end", max > 1 && node.scrollLeft < max - 1);
  }

  function reveal() {
    const selected = node.querySelector<HTMLElement>('[aria-selected="true"], [aria-current]:not([aria-current="false"])');
    selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    measure();
  }

  node.addEventListener("scroll", measure, { passive: true });
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
  resize?.observe(node);
  reveal();

  return {
    update(next?: unknown) {
      active = next;
      reveal();
    },
    destroy() {
      node.removeEventListener("scroll", measure);
      resize?.disconnect();
    },
  };
}
