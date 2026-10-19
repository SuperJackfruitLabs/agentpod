import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BREAKPOINTS, above, upTo } from "./breakpoints";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(svelte|ts|css)$/.test(name) && !/\.test\.ts$/.test(name) && !name.startsWith("vitest-setup")) out.push(path);
  }
  return out;
}

const named = new Set<number>(Object.values(BREAKPOINTS));

describe("breakpoints", () => {
  it("builds both sides of a breakpoint without a gap or an overlap", () => {
    expect(upTo("phone")).toBe("(max-width: 900px)");
    expect(above("phone")).toBe("(min-width: 901px)");
    expect(upTo("rail")).toBe("(max-width: 1240px)");
    expect(above("split")).toBe("(min-width: 701px)");
    expect(upTo("cards")).toBe("(max-width: 767px)");
  });

  // Pins every use: a width in a media query, a Tailwind arbitrary `min-[N]`
  // or `max-[N]`, anywhere in src, must be a named breakpoint (max-width: N,
  // min-width: N+1). A new one goes into BREAKPOINTS first.
  it("every media width in src is a named breakpoint", () => {
    const stray: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\((max|min)-width:\s*(\d+)px\)/g)) {
        const n = Number(m[2]);
        const ok = m[1] === "max" ? named.has(n) : named.has(n - 1);
        if (!ok) stray.push(`${file.slice(SRC.length)}: ${m[0]}`);
      }
      for (const m of text.matchAll(/\b(min|max)-\[(\d+)px\]:/g)) {
        const n = Number(m[2]);
        const ok = m[1] === "min" ? named.has(n - 1) : false;
        if (!ok) stray.push(`${file.slice(SRC.length)}: ${m[0]}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("components ask matchMedia through the named helpers, not a literal width", () => {
    const literal: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith("breakpoints.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (/(matchMedia|MediaQuery)\(\s*["'`]\((max|min)-width/.test(text)) literal.push(file.slice(SRC.length));
    }
    expect(literal).toEqual([]);
  });
});
