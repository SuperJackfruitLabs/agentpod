import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { deniedRule, deniedStationPath } from "./paths";

// The same vectors the node's Denied is tested against (internal/descriptor/guardedfs_test.go).
const vectors = z
  .object({ cases: z.array(z.object({ path: z.string(), rule: z.string().nullable() })) })
  .parse(JSON.parse(readFileSync(new URL("../fixtures/denied-paths-v1.json", import.meta.url), "utf8")));

describe("deniedRule", () => {
  test("has the vectors", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(40);
  });
  for (const c of vectors.cases) {
    test(`${JSON.stringify(c.path)} → ${c.rule ?? "ordinary"}`, () => {
      expect(deniedRule(c.path)).toBe(c.rule);
    });
  }
});

describe("deniedStationPath", () => {
  test("refuses a denied folder by what it would contain", () => {
    for (const p of [".ssh", ".git", "home/me/.ssh", ".ssh/", ".aws", ".hermes", "a\\.git"]) {
      expect(deniedStationPath(p)).not.toBeNull();
    }
  });
  test("refuses denied files", () => {
    expect(deniedStationPath(".env")).toBe(".env*");
    expect(deniedStationPath(".ssh/id_ed25519")).toBe(".ssh/");
    expect(deniedStationPath(".git/config")).toBe(".git/");
  });
  test("passes the root and ordinary paths", () => {
    for (const p of ["", ".", "docs", "docs/plan.md", "SOUL.md", ".github", ".github/workflows/ci.yml", "src/environment.ts"]) {
      expect(deniedStationPath(p)).toBeNull();
    }
  });
});
