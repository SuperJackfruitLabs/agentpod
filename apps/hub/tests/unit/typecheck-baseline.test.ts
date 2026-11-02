/**
 * The hub's typecheck, held as a test.
 *
 * `src` is green: `bun run typecheck` (`tsconfig.json`, `src/**\/*` only)
 * reports nothing, and CI's hub job runs it as a step of its own. This file
 * asserts it too, so a local `bun test` says so without a second command.
 *
 * The tests are not all green yet. `tsconfig.tests.json` adds `tests/**\/*`,
 * and `typecheck-known-red-tests.txt` records, per file, the errors still
 * there and why each is not mechanical. The comparison is exact in both
 * directions — the repo's ratchet shape: a new error fails, and so does a
 * fixed one until the file is lowered to match. Per file, never a single
 * total: one new error hiding behind one fixed error is exactly the move a
 * total cannot see.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HUB_ROOT = join(import.meta.dir, "..", "..");
const TESTS_BASELINE_FILE = join(HUB_ROOT, "typecheck-known-red-tests.txt");

/** `tests/integration/x.test.ts(320,17): error TS2769: …` → `tests/integration/x.test.ts`. */
const ERROR_LINE = /^(\S+?)\(\d+,\d+\): error TS\d+:/;

type Counts = Record<string, number>;

function parseBaseline(text: string): Counts {
  const counts: Counts = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [file, count] = trimmed.split(/\s+/);
    if (!file || !count) throw new Error(`unparseable baseline line: ${line}`);
    counts[file] = Number(count);
  }
  return counts;
}

function parseCompilerOutput(output: string): Counts {
  const counts: Counts = {};
  for (const line of output.split("\n")) {
    const match = ERROR_LINE.exec(line);
    // Indented continuation lines ("Type 'undefined' is not assignable…") belong
    // to the error above them; counting them would make the baseline depend on
    // how verbose a given overload failure happens to be.
    const file = match?.[1];
    if (!file) continue;
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return counts;
}

async function run(cmd: string[]): Promise<{ output: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, { cwd: HUB_ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { output: stdout + stderr, exitCode: await proc.exited };
}

describe("the hub's source typecheck", () => {
  test("reports no errors", async () => {
    const { output, exitCode } = await run(["bun", "run", "typecheck"]);
    // Both, because each alone can lie: a non-zero exit with no parseable line
    // (a config error) and a parseable line with exit 0 are both failures.
    expect(parseCompilerOutput(output)).toEqual({});
    expect(exitCode, output).toBe(0);
  }, 180_000);
});

describe("the tests typecheck baseline", () => {
  test("matches what the compiler actually reports", async () => {
    const { output } = await run(["bun", "run", "typecheck:tests"]);
    const documented = parseBaseline(readFileSync(TESTS_BASELINE_FILE, "utf8"));

    // Whole objects, so a failure names every file that moved in either
    // direction. Fewer errors than the baseline is good news that still turns
    // this red: lower the file and say so in the diff.
    expect(parseCompilerOutput(output)).toEqual(documented);
  }, 300_000);

  test("the tests config really compiles tests/", async () => {
    // Guards the guard: a `tsconfig.tests.json` that silently stopped including
    // `tests/**\/*` would compare `src` to an empty baseline and pass while
    // checking nothing. Asked of the compiler's own file list, not of its
    // errors, because the errors are meant to reach zero.
    const { output, exitCode } = await run(["bun", "run", "typecheck:tests", "--listFilesOnly"]);
    expect(exitCode, output).toBe(0);
    const testFiles = output.split("\n").filter((f) => f.startsWith(join(HUB_ROOT, "tests") + "/"));
    expect(testFiles.length, "tsconfig.tests.json lists the test files").toBeGreaterThan(100);
  }, 180_000);

  test("the baseline parses and holds only tests/ paths with positive counts", () => {
    const documented = parseBaseline(readFileSync(TESTS_BASELINE_FILE, "utf8"));
    for (const [file, count] of Object.entries(documented)) {
      // A `src/` row would be a number the source typecheck says must be zero.
      expect(file, "the tests baseline holds only tests/ paths").toStartWith("tests/");
      expect(count, `${file} must carry a positive error count`).toBeGreaterThan(0);
    }
  });
});
