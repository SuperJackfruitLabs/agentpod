import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The store touches matchMedia at module init — ES imports are hoisted ahead
// of plain statements, so the stub must go through vi.hoisted() to actually
// run before "./store.svelte" is evaluated (a bare vi.stubGlobal() call above
// the import, as suggested by the brief, executes too late and jsdom has no
// native matchMedia).
vi.hoisted(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
});

import { themeStore, colorSchemesMap } from "./store.svelte";

describe("status tokens are fixed, not scheme-derived", () => {
  it("leaves --status-* unset on the root for two schemes with different cyber-* values", () => {
    const root = document.documentElement;
    const statusVars = [
      "--status-running",
      "--status-starting",
      "--status-error",
      "--status-sleeping",
      "--status-stopped",
      "--status-unknown",
    ];

    const schemeA = colorSchemesMap.get("cyberpunk") ?? [...colorSchemesMap.values()][0];
    themeStore.setColorScheme(schemeA.id);
    for (const cssVar of statusVars) {
      expect(root.style.getPropertyValue(cssVar)).toBe("");
    }

    const schemeB = colorSchemesMap.get("twitter") ?? [...colorSchemesMap.values()][1];
    themeStore.setColorScheme(schemeB.id);
    for (const cssVar of statusVars) {
      expect(root.style.getPropertyValue(cssVar)).toBe("");
    }
  });

  it("removes a --status-* inline style left over from a previous session", () => {
    const root = document.documentElement;
    // Simulate a user who applied a scheme before this change: those five
    // `cyber-*` writes are still sitting on <html> as inline styles.
    root.style.setProperty("--status-running", "oklch(0.5 0.2 150)");
    root.style.setProperty("--status-degraded", "oklch(0.5 0.2 80)");

    const scheme = colorSchemesMap.get("cyberpunk") ?? [...colorSchemesMap.values()][0];
    themeStore.setColorScheme(scheme.id);

    expect(root.style.getPropertyValue("--status-running")).toBe("");
    expect(root.style.getPropertyValue("--status-degraded")).toBe("");
  });

  it("does not set an inline --radius override, leaving the CSS default in app.css to govern", () => {
    const scheme = colorSchemesMap.get("twitter") ?? [...colorSchemesMap.values()][0];
    themeStore.setColorScheme(scheme.id);

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius")).toBe("");
  });
  // The store not WRITING the tokens is only half of it. `--status-stopped`
  // was declared as `var(--muted-foreground)`, which is a token every scheme
  // sets — so a theme still owned one of the six, and under Cyberpunk the
  // "stopped" segment went near-black. Caught by looking at the running app,
  // not by any assertion, so this pins the stylesheet itself. jsdom cannot
  // resolve app.css (css:false), so read the file the way fonts.test.ts does.
  it("declares every --status-* as a literal, never as another scheme's token", () => {
    const appCss = readFileSync(join(__dirname, "../../app.css"), "utf-8");
    const declarations = [...appCss.matchAll(/--status-[a-z]+:\s*([^;]+);/g)];

    expect(declarations.length).toBeGreaterThan(0);
    for (const [whole, value] of declarations) {
      expect(value, `${whole.trim()} must not depend on a scheme-owned token`).not.toContain("var(");
    }
  });
});
