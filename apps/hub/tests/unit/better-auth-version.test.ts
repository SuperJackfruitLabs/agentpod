import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

// The package's exports map does not expose package.json to the type checker,
// so read the installed manifest from disk, beside the resolved entry point.
async function installedVersion(): Promise<string> {
  let dir = dirname(Bun.resolveSync("better-auth", import.meta.dir));
  while (!(await Bun.file(join(dir, "package.json")).exists())) dir = dirname(dir);
  const manifest = (await Bun.file(join(dir, "package.json")).json()) as { name: string; version: string };
  if (manifest.name !== "better-auth") throw new Error(`expected better-auth, found ${manifest.name}`);
  return manifest.version;
}

// 1.7.7 fixes a critical magic-link account takeover (GHSA-965c-763c-88jm)
// and an ID-token sign-in that ignored disableSignUp. Nothing below it is allowed.
const FLOOR = [1, 7, 7] as const;

function atLeast(version: string, floor: readonly number[]): boolean {
  const parts = (version.split("-")[0] ?? "").split(".").map(Number);
  for (let i = 0; i < floor.length; i++) {
    const have = parts[i] ?? 0;
    const want = floor[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

describe("better-auth version floor", () => {
  test("installed better-auth is at least 1.7.7", async () => {
    expect(atLeast(await installedVersion(), FLOOR)).toBe(true);
  });

  test("the comparison itself rejects 1.7.5 and accepts 1.8.0", () => {
    expect(atLeast("1.7.5", FLOOR)).toBe(false);
    expect(atLeast("1.7.7", FLOOR)).toBe(true);
    expect(atLeast("1.8.0", FLOOR)).toBe(true);
    expect(atLeast("2.0.0-beta.1", FLOOR)).toBe(true);
  });
});
