/**
 * The old top bar pinned a 44px sign-out button and appearance link by class
 * name. Both moved into the account menu (desktop) and the More sheet (phone),
 * which are sized in shell.css, so the floor is pinned on the stylesheet here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const shell = readFileSync(resolve(process.cwd(), "src/lib/styles/shell.css"), "utf8");

function rulesFor(selector: string): string[] {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...shell.matchAll(new RegExp(`${esc}(?![\\w-])[^{,]*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
}

describe("shell: account and More targets keep the 44px floor", () => {
  it.each([".ap-acct__chip", ".ap-acct__item", ".ap-more__item"])("%s has min-height >= 44px, on every vibe", (sel) => {
    const rules = rulesFor(sel);
    const base = rules.map((r) => r.match(/min-height:\s*(\d+)px/)).find(Boolean);
    expect(base, `${sel} base min-height`).toBeTruthy();
    expect(Number(base![1])).toBeGreaterThanOrEqual(44);
    for (const r of rules) {
      const mh = r.match(/(?:^|;|\s)(min-height|height|block-size):\s*(\d+)px/);
      if (mh) expect(Number(mh[2]), `${sel} ${mh[1]}`).toBeGreaterThanOrEqual(44);
    }
  });
});
