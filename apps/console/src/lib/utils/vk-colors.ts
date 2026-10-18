/**
 * Colours for the widgets that cannot read CSS variables (xterm, Monaco, Shiki's
 * inline styles): read the live vibekit tokens and hand back hex.
 *
 * Every colour comes from a vibekit token (accent, success, danger, signal, muted ...),
 * so the terminal and the editors belong to the vibe. Where a token is too close to
 * the background to read as text, its lightness is moved in code until it passes
 * (`ensureContrast`), and the tests pin that for every vibe and theme.
 */

/** Reads one token's value. `tokenHex` is the live one; tests pass their own. */
export type TokenReader = (name: string) => string;

const ATTRS = ["data-vibe", "data-theme", "data-accent", "data-product"];

function tokenName(name: string): string {
  return name.startsWith("--") ? name : `--vk-color-${name}`;
}

/**
 * The computed value of a vibekit token as `#rrggbb` ("" when it is not set).
 * `name` is a colour role (`"accent"` reads `--vk-color-accent`) or a full custom property.
 */
export function tokenHex(name: string, el?: Element): string {
  if (typeof document === "undefined") return "";
  const target = el ?? document.documentElement;
  const raw = getComputedStyle(target).getPropertyValue(tokenName(name)).trim();
  return toHex(raw);
}

/** Normalises `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()/rgba()` to `#rrggbb`; anything else gives "". */
export function toHex(value: string): string {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return "#" + [...m[1]].map((c) => c + c).join("");
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) return "#" + m[1];
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(v);
  if (m) return rgbToHex([Number(m[1]), Number(m[2]), Number(m[3])]);
  return "";
}

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = toHex(hex) || "#000000";
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

function rgbToHex(rgb: RGB): string {
  return "#" + rgb.map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0")).join("");
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.18;
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** Moves `l` (0..1) of a colour by `delta`, clamped. */
export function shiftLightness(hex: string, delta: number): string {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb([h, s, Math.min(1, Math.max(0, l + delta))]));
}

/**
 * The colour itself when it reads at `min` against `bg`; otherwise the same hue with its
 * lightness moved away from the background until it does (darker on a light ground,
 * lighter on a dark one).
 */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  let c = toHex(fg) || (isDark(bg) ? "#ffffff" : "#000000");
  const step = isDark(bg) ? 0.02 : -0.02;
  for (let i = 0; i < 50 && contrast(c, bg) < min; i++) c = shiftLightness(c, step);
  return c;
}

/** Mixes two colours, `t` of `b` (0..1). */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(ca.map((v, i) => v + (cb[i] - v) * t) as RGB);
}

function read(r: TokenReader, name: string, fallback: string): string {
  return toHex(r(name)) || fallback;
}

/** The ground and the eight text roles every widget palette is built from. */
export interface VibePalette {
  dark: boolean;
  bg: string;
  surface: string;
  raised: string;
  text: string;
  muted: string;
  faint: string;
  line: string;
  accent: string;
  /** ANSI-ish roles, each readable (>= 4.5) on `bg`. */
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
}

/**
 * The vibe's palette for code and terminals. Roles: red = danger, green = success,
 * yellow = signal, blue = accent, magenta = the console's sleeping violet (`--ap-violet`),
 * cyan = the console's info tone (`--ap-info`; between blue and green
 * where info is the accent, as in Studio). Each is moved to 4.5:1 on the background.
 */
export function vibePalette(r: TokenReader = tokenHex): VibePalette {
  const bg = read(r, "bg", "#ffffff");
  const dark = isDark(bg);
  const text = read(r, "text", dark ? "#f4f4f5" : "#18181b");
  const fit = (name: string, fallback: string) => ensureContrast(read(r, name, fallback), bg);
  const blue = fit("accent", "#2f6fdb");
  const green = fit("success", "#2e7d32");
  let cyan = fit("--ap-info", "#2a8bb0");
  // Studio draws info with its accent: keep cyan its own colour, between blue and green.
  if (cyan === blue) cyan = ensureContrast(mix(blue, green, 0.5), bg);
  return {
    dark,
    bg,
    surface: read(r, "surface", bg),
    raised: read(r, "raised", bg),
    text,
    muted: fit("muted", text),
    faint: read(r, "faint", text),
    line: read(r, "line", text),
    accent: read(r, "accent", text),
    red: fit("danger", "#c0392b"),
    green,
    yellow: fit("signal", "#b7791f"),
    blue,
    magenta: fit("--ap-violet", "#7c5cc4"),
    cyan,
  };
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The xterm theme for the vibe and theme showing now: hex everywhere, 16 ANSI colours. */
export function terminalTheme(r: TokenReader = tokenHex): TerminalTheme {
  const p = vibePalette(r);
  // Bright variants: a step further from the ground, still readable.
  const bright = (c: string) => ensureContrast(shiftLightness(c, p.dark ? 0.1 : -0.08), p.bg);
  return {
    background: p.bg,
    foreground: p.text,
    cursor: p.accent,
    cursorAccent: p.bg,
    selectionBackground: mix(p.bg, p.accent, 0.3),
    selectionForeground: p.text,
    black: p.dark ? p.raised : p.text,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.magenta,
    cyan: p.cyan,
    white: p.dark ? p.text : p.raised,
    brightBlack: p.muted,
    brightRed: bright(p.red),
    brightGreen: bright(p.green),
    brightYellow: bright(p.yellow),
    brightBlue: bright(p.blue),
    brightMagenta: bright(p.magenta),
    brightCyan: bright(p.cyan),
    brightWhite: p.dark ? "#ffffff" : p.surface,
  };
}

/** Syntax roles shared by Monaco and Shiki, so code reads the same in both. */
export interface SyntaxPalette {
  foreground: string;
  background: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  constant: string;
  punctuation: string;
  link: string;
}

export function syntaxPalette(r: TokenReader = tokenHex, ground?: string): SyntaxPalette {
  const p = vibePalette(r);
  const bg = ground ?? p.bg;
  const fit = (c: string) => ensureContrast(c, bg);
  return {
    foreground: fit(p.text),
    background: bg,
    comment: fit(p.muted),
    keyword: fit(p.blue),
    string: fit(p.green),
    number: fit(p.yellow),
    function: fit(p.magenta),
    type: fit(p.cyan),
    constant: fit(p.red),
    punctuation: fit(p.muted),
    link: fit(p.blue),
  };
}

export const MONACO_THEME = "agentpod-vibe";

/** A Monaco standalone theme from the tokens (`monaco.editor.defineTheme(MONACO_THEME, ...)`). */
export function monacoTheme(r: TokenReader = tokenHex) {
  const p = vibePalette(r);
  const s = syntaxPalette(r, p.surface);
  const fg = (c: string) => c.replace("#", "");
  return {
    base: (p.dark ? "vs-dark" : "vs") as "vs" | "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: fg(s.foreground) },
      { token: "comment", foreground: fg(s.comment), fontStyle: "italic" },
      { token: "keyword", foreground: fg(s.keyword) },
      { token: "string", foreground: fg(s.string) },
      { token: "number", foreground: fg(s.number) },
      { token: "type", foreground: fg(s.type) },
      { token: "function", foreground: fg(s.function) },
      { token: "constant", foreground: fg(s.constant) },
      { token: "delimiter", foreground: fg(s.punctuation) },
      { token: "key", foreground: fg(s.keyword) },
      { token: "attribute.name", foreground: fg(s.type) },
      { token: "attribute.value", foreground: fg(s.string) },
      { token: "tag", foreground: fg(s.keyword) },
    ],
    colors: {
      "editor.background": p.surface,
      "editor.foreground": s.foreground,
      "editorLineNumber.foreground": p.faint,
      "editorLineNumber.activeForeground": p.text,
      "editorCursor.foreground": p.accent,
      "editor.selectionBackground": mix(p.surface, p.accent, 0.28),
      "editor.lineHighlightBackground": p.raised,
      "editorIndentGuide.background1": p.line,
      "editorWidget.background": p.surface,
      "editorWidget.border": p.line,
      "editorGutter.background": p.surface,
    },
  };
}

/**
 * The Shiki css-variables theme's custom properties (`--shiki-*`), from the same syntax
 * palette. Written on `<html>` so every code block and markdown preview repaints with
 * the vibe without re-highlighting.
 */
export function shikiVars(r: TokenReader = tokenHex): Record<string, string> {
  const p = vibePalette(r);
  const s = syntaxPalette(r, p.raised);
  return {
    "--shiki-foreground": s.foreground,
    "--shiki-background": p.raised,
    "--shiki-token-comment": s.comment,
    "--shiki-token-keyword": s.keyword,
    "--shiki-token-string": s.string,
    "--shiki-token-string-expression": s.string,
    "--shiki-token-constant": s.constant,
    "--shiki-token-function": s.function,
    "--shiki-token-parameter": s.foreground,
    "--shiki-token-punctuation": s.punctuation,
    "--shiki-token-link": s.link,
  };
}

export function applyShikiVars(el: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(shikiVars())) el.style.setProperty(k, v);
}

/**
 * Calls `cb` after `<html>`'s vibe, theme or accent changes (also when the change lands
 * inside a view transition). Returns the unsubscribe.
 */
export function onAppearanceChange(cb: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const obs = new MutationObserver(() => cb());
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ATTRS });
  return () => obs.disconnect();
}

/** Keeps `<html>`'s Shiki variables in step with the appearance. Returns the stop. */
export function startWidgetColours(): () => void {
  applyShikiVars();
  return onAppearanceChange(() => applyShikiVars());
}
