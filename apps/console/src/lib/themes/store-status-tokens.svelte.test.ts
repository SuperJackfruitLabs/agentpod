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

describe("status token application", () => {
  it("writes --status-* vars from the scheme's accent colors on scheme change", () => {
    const scheme = colorSchemesMap.get("cyberpunk") ?? [...colorSchemesMap.values()][0];
    themeStore.setColorScheme(scheme.id);

    const root = document.documentElement;
    const mode = themeStore.resolvedMode; // "light" | "dark"
    const styles = scheme.styles[mode];

    expect(root.style.getPropertyValue("--status-running")).toBe(styles["cyber-emerald"]);
    expect(root.style.getPropertyValue("--status-degraded")).toBe(styles["cyber-amber"]);
    expect(root.style.getPropertyValue("--status-error")).toBe(styles["cyber-red"]);
    expect(root.style.getPropertyValue("--status-starting")).toBe(styles["cyber-cyan"]);
    expect(root.style.getPropertyValue("--status-sleeping")).toBe(styles["cyber-magenta"]);
  });
});
