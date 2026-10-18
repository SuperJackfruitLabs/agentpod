import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contrast,
  ensureContrast,
  monacoTheme,
  onAppearanceChange,
  shikiVars,
  syntaxPalette,
  terminalTheme,
  tokenHex,
  toHex,
} from "./vk-colors";
import { readerFor, THEMES, VIBES } from "./vk-tokens.fixture";

const HEX = /^#[0-9a-f]{6}$/;
const NORMAL = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
const ALL16 = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("style");
});

describe("tokenHex", () => {
  it("reads a colour role from the computed vibekit token", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (n: string) => (n === "--vk-color-accent" ? " #3A6FC8 " : ""),
    } as unknown as CSSStyleDeclaration);
    expect(tokenHex("accent")).toBe("#3a6fc8");
  });

  it("reads a full custom property and normalises rgb() and short hex", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (n: string) => ({ "--ap-violet": "rgb(124, 92, 196)", "--vk-color-bg": "#fff" })[n] ?? "",
    } as unknown as CSSStyleDeclaration);
    expect(tokenHex("--ap-violet")).toBe("#7c5cc4");
    expect(tokenHex("bg")).toBe("#ffffff");
    expect(tokenHex("missing")).toBe("");
  });

  it("toHex drops alpha and rejects non-colours", () => {
    expect(toHex("#11223344")).toBe("#112233");
    expect(toHex("oklch(0.5 0.1 200)")).toBe("");
  });
});

describe("ensureContrast", () => {
  it("leaves a readable colour alone and moves a weak one until it reads", () => {
    expect(ensureContrast("#000000", "#ffffff")).toBe("#000000");
    const fixed = ensureContrast("#7fd3a0", "#fff8ee"); // Daylight's success on its ground: too light
    expect(contrast("#7fd3a0", "#fff8ee")).toBeLessThan(4.5);
    expect(contrast(fixed, "#fff8ee")).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(VIBES.flatMap((v) => THEMES.map((t) => [v, t] as const)))("%s / %s", (vibe, theme) => {
  const r = readerFor(vibe, theme);

  it("terminal theme is hex, comes from the vibe's ground, and its normal colours read at 4.5:1", () => {
    const t = terminalTheme(r);
    expect(t.background).toBe(toHex(r("bg")));
    expect(t.foreground).toBe(toHex(r("text")));
    for (const k of ALL16) expect(t[k], k).toMatch(HEX);
    for (const k of NORMAL) expect(contrast(t[k], t.background), `${k} ${t[k]}`).toBeGreaterThanOrEqual(4.5);
    for (const k of NORMAL) {
      const b = `bright${k[0].toUpperCase()}${k.slice(1)}` as keyof typeof t;
      expect(contrast(t[b], t.background), String(b)).toBeGreaterThanOrEqual(4.5);
    }
    expect(new Set(NORMAL.map((k) => t[k])).size).toBe(NORMAL.length);
  });

  it("Monaco theme is built from the tokens with readable syntax colours", () => {
    const m = monacoTheme(r);
    expect(m.base).toBe(theme === "dark" ? "vs-dark" : "vs");
    expect(m.colors["editor.background"]).toBe(toHex(r("surface")));
    for (const rule of m.rules) {
      expect(contrast(`#${rule.foreground}`, m.colors["editor.background"]), rule.token).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("Shiki variables are readable on the code background", () => {
    const v = shikiVars(r);
    for (const [k, c] of Object.entries(v)) {
      expect(c, k).toMatch(HEX);
      if (k !== "--shiki-background") expect(contrast(c, v["--shiki-background"]), k).toBeGreaterThanOrEqual(4.5);
    }
  });
});

it("the terminal theme changes with data-vibe and data-theme", () => {
  const a = terminalTheme(readerFor("daylight", "light"));
  const b = terminalTheme(readerFor("daylight", "dark"));
  const c = terminalTheme(readerFor("studio", "light"));
  expect(a.background).not.toBe(b.background);
  expect(a.background).not.toBe(c.background);
  expect(a.blue).not.toBe(b.blue);
});

it("Monaco and Shiki share one syntax palette", () => {
  const r = readerFor("paper", "light");
  const s = syntaxPalette(r, toHex(r("raised")));
  expect(shikiVars(r)["--shiki-token-keyword"]).toBe(s.keyword);
});

it("onAppearanceChange fires when <html>'s vibe or theme changes, and stops when unsubscribed", async () => {
  const cb = vi.fn();
  const off = onAppearanceChange(cb);
  document.documentElement.setAttribute("data-theme", "dark");
  await Promise.resolve();
  expect(cb).toHaveBeenCalledTimes(1);
  document.documentElement.setAttribute("data-vibe", "paper");
  await Promise.resolve();
  expect(cb).toHaveBeenCalledTimes(2);
  off();
  document.documentElement.setAttribute("data-theme", "light");
  await Promise.resolve();
  expect(cb).toHaveBeenCalledTimes(2);
});

it("startWidgetColours writes the Shiki variables on <html> and rewrites them on an appearance change", async () => {
  let theme = "light";
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () => ({ getPropertyValue: (n: string) => (n === "--vk-color-bg" || n === "--vk-color-raised" ? (theme === "light" ? "#ffffff" : "#101010") : "") }) as unknown as CSSStyleDeclaration,
  );
  const { startWidgetColours } = await import("./vk-colors");
  const stop = startWidgetColours();
  const html = document.documentElement;
  expect(html.style.getPropertyValue("--shiki-background")).toBe("#ffffff");
  theme = "dark";
  html.setAttribute("data-theme", "dark");
  await Promise.resolve();
  expect(html.style.getPropertyValue("--shiki-background")).toBe("#101010");
  stop();
});
