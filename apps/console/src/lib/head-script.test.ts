import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HEAD_SCRIPT } from "@superjackfruit/vibekit";
import { describe, expect, it } from "vitest";

// Paths from the package root (vitest runs there): jsdom gives import.meta.url a non-file scheme.
const html = readFileSync(resolve(process.cwd(), "src/app.html"), "utf8");

describe("app.html paints the right vibe on the first frame", () => {
  it("inlines vibekit HEAD_SCRIPT verbatim, so an upgrade cannot leave a stale copy", () => {
    expect(html).toContain(HEAD_SCRIPT);
  });
  it("runs the legacy-theme seed before HEAD_SCRIPT and both before %sveltekit.head%", () => {
    const seed = html.indexOf("localStorage.getItem('agentpod-theme-mode')");
    const head = html.indexOf(HEAD_SCRIPT);
    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(head);
    expect(head).toBeLessThan(html.indexOf("%sveltekit.head%"));
  });
  it("no longer uses the .dark class or the OS preference", () => {
    expect(html).not.toMatch(/classList\.add\('dark'\)|classList\.add\("dark"\)/);
    expect(html).not.toMatch(/prefers-color-scheme: dark\)'\)\.matches/);
  });
  it("names the product on <html>, so HEAD_SCRIPT paints its accent on the first frame", () => {
    expect(html).toMatch(/<html lang="en" data-product="agentpod">/);
  });
  it("paints each vibe and theme's own background on the first frame, matching vibekit's tokens", () => {
    const tokens = readFileSync(
      resolve(process.cwd(), "node_modules/@superjackfruit/vibekit/dist/styles/tokens.css"),
      "utf8",
    );
    for (const vibe of ["daylight", "paper", "studio", "quiet"]) {
      for (const theme of ["light", "dark"]) {
        const block = new RegExp(
          `\\[data-vibe="${vibe}"\\]\\[data-theme="${theme}"\\] \\{[^}]*?--vk-color-bg: (#[0-9a-f]+);`,
        ).exec(tokens);
        expect(block, `${vibe} ${theme} in tokens.css`).not.toBeNull();
        const rule =
          vibe === "daylight" && theme === "light"
            ? /:where\(html\)\{background:(#[0-9a-f]+)/
            : new RegExp(`:where\\(html\\[data-vibe=${vibe}\\]\\[data-theme=${theme}\\]\\)\\{background:(#[0-9a-f]+)`);
        expect(rule.exec(html)?.[1], `${vibe} ${theme}`).toBe(block![1]);
      }
    }
  });
});
