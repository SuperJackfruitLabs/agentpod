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
