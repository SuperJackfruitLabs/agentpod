/**
 * preset-accents.test.ts
 *
 * Every color scheme feeds its five `cyber-*` accents into the
 * `--status-*` tokens (store.svelte.ts: emerald→running, amber→degraded,
 * red→error, cyan→starting, magenta→sleeping — see
 * store-status-tokens.svelte.test.ts). If two accents share the same
 * value, two different statuses become visually identical, defeating the
 * whole point of status coloring.
 *
 * This test asserts, for every scheme × {light, dark}, that the five
 * accent values are pairwise distinct strings, plus a cheap semantic
 * floor: cyber-red (error) must never equal cyber-emerald (running) —
 * the single most safety-critical confusion (an errored agent reading as
 * healthy).
 *
 * Run: cd apps/console && pnpm test preset-accents
 */

import { describe, expect, test } from "vitest";
import { colorSchemes } from "./colors";
import type { ThemeStyleProps } from "./presets/types";

const ACCENT_KEYS = [
  "cyber-cyan",
  "cyber-emerald",
  "cyber-magenta",
  "cyber-amber",
  "cyber-red",
] as const satisfies readonly (keyof ThemeStyleProps)[];

for (const scheme of colorSchemes) {
  for (const mode of ["light", "dark"] as const) {
    describe(`${scheme.id} (${mode})`, () => {
      const styles = scheme.styles[mode];
      const accents = ACCENT_KEYS.map((key) => styles[key]);

      test("all five accent values are pairwise distinct", () => {
        const unique = new Set(accents);
        expect(unique.size).toBe(ACCENT_KEYS.length);
      });

      test("cyber-red (error) !== cyber-emerald (running)", () => {
        expect(styles["cyber-red"]).not.toBe(styles["cyber-emerald"]);
      });
    });
  }
}
