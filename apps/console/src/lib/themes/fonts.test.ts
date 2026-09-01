import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fontPairings, fontPairingsMap, DEFAULT_FONT_PAIRING_ID } from "./fonts/index";

// app.css is the source of truth for what's actually bundled; a pairing
// naming a font that was never given an @font-face block silently falls
// back to the browser default, which is the actual failure mode this test
// catches.
const appCss = readFileSync(join(__dirname, "../../app.css"), "utf-8");
const bundledFamilies = new Set(
  [...appCss.matchAll(/font-family:\s*'([^']+)'/g)].map((match) => match[1]),
);

describe("DEFAULT_FONT_PAIRING_ID", () => {
  it("resolves in fontPairingsMap", () => {
    expect(fontPairingsMap.has(DEFAULT_FONT_PAIRING_ID)).toBe(true);
  });
});

describe("every font pairing names only bundled fonts", () => {
  for (const pairing of fontPairings) {
    it(`${pairing.id}: ${pairing.label}`, () => {
      expect(bundledFamilies.has(pairing.fonts["font-body"])).toBe(true);
      expect(bundledFamilies.has(pairing.fonts["font-heading"])).toBe(true);
      expect(bundledFamilies.has(pairing.fonts["font-mono"])).toBe(true);
    });
  }
});
