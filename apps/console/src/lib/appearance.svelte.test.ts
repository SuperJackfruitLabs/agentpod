// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppearanceStore, LEGACY_KEYS, roughPlace } from "./appearance.svelte";

const html = () => document.documentElement;
const at = (h: number) => () => new Date(2026, 9, 19, h, 0, 0);
const written: string[] = [];
const writer = (c: string) => {
  written.push(c);
  document.cookie = c;
};

function reset(): void {
  document.cookie = "vk_appearance=; Max-Age=0; Path=/";
  for (const a of ["data-vibe", "data-theme", "data-phase", "data-time", "data-accent", "data-product"]) {
    html().removeAttribute(a);
  }
  localStorage.clear();
  written.length = 0;
}

describe("AppearanceStore", () => {
  let s: AppearanceStore;
  beforeEach(() => {
    reset();
    s = new AppearanceStore(writer);
  });
  afterEach(() => s.dispose());

  it("a first visit is Daylight following the sun, cobalt (the product accent), on <html>", () => {
    s.init(at(13));
    expect(html().getAttribute("data-vibe")).toBe("daylight");
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(html().getAttribute("data-phase")).toBe("noon");
    expect(html().getAttribute("data-accent")).toBe("product");
    expect(html().getAttribute("data-product")).toBe("agentpod");
  });

  it("following the sun resolves by the clock: dark at night, light at noon", () => {
    s.init(at(23));
    expect(s.theme).toBe("dark");
    expect(html().getAttribute("data-theme")).toBe("dark");
    s.dispose();
    const day = new AppearanceStore(writer);
    day.init(at(13));
    expect(day.theme).toBe("light");
    expect(html().getAttribute("data-theme")).toBe("light");
    day.dispose();
  });

  it("choosing a vibe writes vk_appearance for this host and paints data-vibe", () => {
    s.init(at(13));
    s.set({ vibe: "studio" });
    const c = written.at(-1)!;
    expect(c).toMatch(/^vk_appearance=studio\.sun\.strong\.0; /);
    expect(c).not.toMatch(/Domain=/i);
    expect(html().getAttribute("data-vibe")).toBe("studio");
  });

  it("choosing a theme writes it and paints data-theme", () => {
    s.init(at(13));
    s.set({ theme: "dark" });
    expect(written.at(-1)).toMatch(/^vk_appearance=daylight\.dark\./);
    expect(html().getAttribute("data-theme")).toBe("dark");
  });

  it("choosing an accent writes agentpod:<accent> and paints data-accent; product clears it", () => {
    s.init(at(13));
    s.setAccent("violet");
    expect(written.at(-1)).toMatch(/agentpod:violet/);
    expect(html().getAttribute("data-accent")).toBe("violet");
    s.setAccent("product");
    expect(written.at(-1)).not.toMatch(/agentpod:/);
    expect(html().getAttribute("data-accent")).toBe("product");
  });

  it("reads the cookie", () => {
    document.cookie = "vk_appearance=paper.dark.subtle.0; Path=/";
    s.init(at(13));
    expect(s.value).toMatchObject({ vibe: "paper", theme: "dark", timeStrength: "subtle" });
    expect(html().getAttribute("data-vibe")).toBe("paper");
  });

  it("a malformed cookie falls back to the defaults and does not throw", () => {
    document.cookie = "vk_appearance=neon.%3Cimg%3E; Path=/";
    expect(() => s.init(at(13))).not.toThrow();
    expect(s.value.vibe).toBe("daylight");
    expect(s.value.theme).toBe("sun");
  });

  it("toggleTheme picks the opposite of what is showing", () => {
    s.init(at(13));
    s.toggleTheme();
    expect(s.value.theme).toBe("dark");
    s.toggleTheme();
    expect(s.value.theme).toBe("light");
  });

  it("rounds a place to one decimal", () => {
    expect(roughPlace({ latitude: 51.5072, longitude: -0.1276 })).toEqual({ latitude: 51.5, longitude: -0.1 });
  });
});

describe("the old theme system", () => {
  let s: AppearanceStore;
  beforeEach(() => {
    reset();
    s = new AppearanceStore(writer);
  });
  afterEach(() => s.dispose());

  it("a saved agentpod-theme-mode of dark seeds the appearance once", () => {
    localStorage.setItem("agentpod-theme-mode", "dark");
    s.init(at(13));
    expect(s.value.theme).toBe("dark");
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(written.at(-1)).toMatch(/^vk_appearance=daylight\.dark\.strong\.0; /);
  });

  it("a saved light seeds light", () => {
    localStorage.setItem("agentpod-theme-mode", "light");
    s.init(at(23));
    expect(s.theme).toBe("light");
  });

  it("system and auto follow the sun (nothing to carry over)", () => {
    for (const mode of ["system", "auto"]) {
      reset();
      localStorage.setItem("agentpod-theme-mode", mode);
      const t = new AppearanceStore(writer);
      t.init(at(13));
      expect(t.value.theme).toBe("sun");
      expect(written).toHaveLength(0);
      t.dispose();
    }
  });

  it("is cleared once read, so a later choice is never overridden", () => {
    for (const k of LEGACY_KEYS) localStorage.setItem(k, "dark");
    s.init(at(13));
    for (const k of LEGACY_KEYS) expect(localStorage.getItem(k)).toBeNull();
    s.set({ theme: "light" });
    s.dispose();
    const again = new AppearanceStore(writer);
    again.init(at(13));
    expect(again.value.theme).toBe("light");
    again.dispose();
  });

  it("never overrides an appearance the person already has", () => {
    document.cookie = "vk_appearance=quiet.light.off.0; Path=/";
    localStorage.setItem("agentpod-theme-mode", "dark");
    s.init(at(13));
    expect(s.value).toMatchObject({ vibe: "quiet", theme: "light" });
    expect(localStorage.getItem("agentpod-theme-mode")).toBeNull();
  });
});
