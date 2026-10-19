/**
 * Test helper: the real token values for a vibe and theme, read from the installed
 * vibekit stylesheets plus the console's own app.css (no browser needed). Only plain
 * attribute selectors are matched, which is all these files use for tokens.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const vkDir = resolve(process.cwd(), "node_modules/@superjackfruit/vibekit");
const files = [
  join(vkDir, "dist/styles/tokens.css"),
  join(vkDir, "dist/styles/accents.css"),
  resolve(process.cwd(), "src/app.css"),
];

export const VIBES = ["daylight", "paper", "studio", "quiet"] as const;
export const THEMES = ["light", "dark"] as const;

type Attrs = Record<string, string>;

function selectorMatches(sel: string, attrs: Attrs): boolean {
  const s = sel.trim();
  if (s === ":root") return true;
  if (!/^(\[[^\]]+\])+$/.test(s)) return false;
  for (const m of s.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)) {
    const [, name, value] = m;
    if (!(name in attrs)) return false;
    if (value !== undefined && attrs[name] !== value) return false;
  }
  return true;
}

export function tokensFor(vibe: string, theme: string): Record<string, string> {
  const attrs: Attrs = { "data-vibe": vibe, "data-theme": theme, "data-accent": "product", "data-product": "agentpod" };
  const out: Record<string, string> = {};
  for (const f of files) {
    const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1].split(",");
      if (!selectors.some((s) => selectorMatches(s, attrs))) continue;
      for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) out[d[1]] = d[2].trim();
    }
  }
  return out;
}

/** A TokenReader over `tokensFor`, resolving `var(--x)` one level at a time. */
export function readerFor(vibe: string, theme: string) {
  const t = tokensFor(vibe, theme);
  const resolveVar = (v: string, depth = 0): string => {
    const m = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/.exec(v.trim());
    if (!m || depth > 5) return v;
    return resolveVar(t[m[1]] ?? m[2] ?? "", depth + 1);
  };
  return (name: string) => resolveVar(t[name.startsWith("--") ? name : `--vk-color-${name}`] ?? "");
}
