import { describe, expect, it } from "vitest";
import { contrast, toHex } from "$lib/utils/vk-colors";
import { readerFor, THEMES, VIBES } from "$lib/utils/vk-tokens.fixture";

const STATUSES = ["running", "degraded", "starting", "stopped", "error", "sleeping", "unknown"];

describe.each(VIBES.flatMap((v) => THEMES.map((t) => [v, t] as const)))("%s / %s", (vibe, theme) => {
  const r = readerFor(vibe, theme);
  it.each(STATUSES)("status text %s reads at 4.5:1 on the page and on a card", (s) => {
    const c = toHex(r(`--status-${s}-text`));
    expect(c, `--status-${s}-text`).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(c, toHex(r("bg")))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c, toHex(r("surface")))).toBeGreaterThanOrEqual(4.5);
  });
});

/** Euclidean distance in sRGB, 0..441. */
function rgbDistance(a: string, b: string): number {
  const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [ch(a), ch(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// Colour is never the only signal (failing states also carry their word), but error must
// still not be drawn like running, degraded like error, or stopped like running. The floor is
// low on purpose: error and degraded are red and red-orange, about 31-38 apart in four vibes.
const PAIRS = [
  ["error", "running"],
  ["error", "degraded"],
  ["running", "stopped"],
] as const;

describe.each(VIBES.flatMap((v) => THEMES.map((t) => [v, t] as const)))("%s / %s status colours differ", (vibe, theme) => {
  const r = readerFor(vibe, theme);
  it.each(PAIRS)("%s and %s are clearly different", (a, b) => {
    const ca = toHex(r(`--status-${a}-text`));
    const cb = toHex(r(`--status-${b}-text`));
    expect(ca).not.toBe(cb);
    expect(rgbDistance(ca, cb), `${a} ${ca} vs ${b} ${cb}`).toBeGreaterThan(20);
  });
});
