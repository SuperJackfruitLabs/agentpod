/**
 * The phone pass: the contracts a 390px screen relies on that jsdom can check.
 * Layout itself is measured in the Playwright sweep (e2e/sweep.spec.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import * as Dialog from "$lib/components/ui/dialog";
import SheetHost from "./phone-sheet.test-host.svelte";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const app = read("src/app.css");
const primitives = read("src/lib/styles/primitives.css");
const pages = read("src/lib/styles/pages.css");
const admin = read("src/lib/styles/admin.css");

afterEach(() => cleanup());

/** The body of the first `@media <query> { ... }` block that contains `needle`. */
function mediaBlockWith(css: string, query: string, needle: string): string | null {
  let at = 0;
  for (;;) {
    const i = css.indexOf(`@media ${query}`, at);
    if (i < 0) return null;
    let depth = 0, j = css.indexOf("{", i);
    const start = j;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) break;
    }
    const body = css.slice(start, j);
    if (body.includes(needle)) return body;
    at = j;
  }
}

describe("phone: strips", () => {
  it("a scroll strip never widens the page", () => {
    const rule = /\.scroll-strip\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(rule).toMatch(/min-width:\s*0/);
  });
});

describe("phone: dialogs and sheets", () => {
  it("a dialog footer stacks with the primary (last) action on top, full width, on a phone", () => {
    const footer = createRawSnippet(() => ({ render: () => `<button>Cancel</button>` }));
    const { container } = render(Dialog.Footer, { props: { children: footer } });
    const el = container.querySelector('[data-slot="dialog-footer"]')!;
    expect(el.className).toContain("flex-col-reverse");
    const block = mediaBlockWith(primitives, "(max-width: 639px)", 'data-slot="dialog-footer"');
    expect(block).toMatch(/width:\s*100%/);
  });

  it("a bottom sheet carries the grab handle; a side sheet does not", () => {
    const bottom = render(SheetHost, { props: { side: "bottom" } });
    expect(document.querySelector('[data-slot="sheet-handle"]')).not.toBeNull();
    bottom.unmount();
    cleanup();
    render(SheetHost, { props: { side: "right" } });
    expect(document.querySelector('[data-slot="sheet-handle"]')).toBeNull();
  });

  it("the palette is full width on a phone", () => {
    const block = mediaBlockWith(admin, "(max-width: 639px)", ".ap-pal");
    expect(block).toMatch(/width:\s*100%/);
  });
});

describe("phone: targets", () => {
  it("under 1024px and on a coarse pointer, buttons, inputs, tabs and links in lists are 44px", () => {
    const block = mediaBlockWith(primitives, "(max-width: 1023px), (pointer: coarse)", "min-height");
    expect(block).not.toBeNull();
    for (const slot of ['data-slot="button"', 'data-slot="input"', 'data-slot="select-trigger"', 'role="tab"']) {
      expect(block, slot).toContain(slot);
    }
  });
});

describe("phone: cards", () => {
  it("the card-table rules live under the cards breakpoint", () => {
    const block = mediaBlockWith(pages, "(max-width: 767px)", ".ap-tbl--cards");
    expect(block).toMatch(/thead\s*\{\s*display:\s*none/);
    expect(block).toMatch(/min-width:\s*0\s*!important/);
  });
});
