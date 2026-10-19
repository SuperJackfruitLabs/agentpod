import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { Button } from "$lib/components/ui/button";

const css = readFileSync(resolve(process.cwd(), "src/lib/styles/primitives.css"), "utf8");
const app = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");

afterEach(() => cleanup());

describe("the primitives take the vibe's look", () => {
  it("app.css loads the per-vibe primitive rules", () => {
    expect(app).toMatch(/@import "\.\/lib\/styles\/primitives\.css"/);
  });

  const slots = ["button", "input", "textarea", "select-trigger", "badge", "card", "tabs-list", "tabs-trigger", "table", "dialog-content", "sheet-content", "dropdown-menu-content", "popover-content", "tooltip-content", "skeleton", "switch", "avatar", "command", "breadcrumb", "separator"];
  it.each(slots)("%s has a rule", (slot) => {
    expect(css).toContain(`[data-slot="${slot}"]`);
  });

  it.each(["daylight", "paper", "studio", "quiet"])("%s has its own rules", (vibe) => {
    expect(css).toContain(`:where([data-vibe="${vibe}"])`);
  });

  it("never uses a .dark class or oklch", () => {
    expect(css).not.toMatch(/\.dark\b|oklch/);
  });

  it("Button exposes its variant and size for the vibe rules", () => {
    const children = createRawSnippet(() => ({ render: () => "<span>Save</span>" }));
    const { getByRole } = render(Button, { props: { variant: "destructive", size: "sm", children } });
    const b = getByRole("button", { name: "Save" });
    expect(b.dataset.variant).toBe("destructive");
    expect(b.dataset.size).toBe("sm");
  });

  // This sheet is unlayered, so it beats Tailwind's layered utilities whatever their specificity:
  // a caller's font-mono or border-destructive/50 only survives if the rule leaves that element out.
  it("the field rule leaves the font to the body and never overrides a caller's font-mono", () => {
    const field = css.match(/:where\(\[data-slot="input"\][^{]*\{[^}]*\}/)![0];
    expect(field).toContain("font-family: inherit");
    expect(field).not.toContain("--vk-font-body");
    expect(field).toContain(':not(.font-mono)');
  });

  it("no outline-button rule overrides a caller's destructive border", () => {
    const all = css.match(/\[data-variant="outline"\]/g)!.length;
    const guarded = css.match(/\[data-variant="outline"\]:not\(\[class\*="border-destructive"\]\)/g)?.length ?? 0;
    expect(all).toBeGreaterThan(0);
    expect(guarded).toBe(all);
  });
});
