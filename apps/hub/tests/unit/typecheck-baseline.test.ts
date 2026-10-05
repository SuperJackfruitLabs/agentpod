/**
 * The known-red typecheck claim, as a check instead of a sentence.
 *
 * `apps/hub/CLAUDE.md` used to say the pre-existing `tsc --noEmit` errors were
 * "in stations.ts files". They were not: nine of the fifteen are in
 * `routes/station-acp.ts`, and exactly one is in a file called `stations.ts`.
 * The sentence was wrong the day it was written and nothing could tell anyone,
 * because no test read it — which is the failure mode this whole suite of
 * documentation fixes exists to close.
 *
 * `typecheck-known-red.txt` now carries the claim as data, and this runs the
 * compiler and holds the file to it. The point is not to keep the errors: it is
 * that the count can only change deliberately. Fixing one turns this red with
 * "fewer errors than the baseline — good news, update the file", which is a far
 * better prompt than a stale paragraph.
 *
 * ─── and the same for the tests, which the compiler had never seen ───────────
 *
 * `tsconfig.json` includes only `src/**\/*`, and no workflow ran `tsc` at all,
 * so not one test file in this app was ever typechecked. That is how
 * `capabilities: ["health", "config.manage"]` — a genuine type error against
 * `Capability[]`, because the capability was missing from the contract's enum —
 * sat in six test files across three merged PRs while every suite stayed green.
 * The compiler would have named all six. Nothing asked it.
 *
 * So `tsconfig.tests.json` adds `tests/**\/*` and `typecheck-known-red-tests.txt`
 * records what that costs today: 224 errors in 51 files, overwhelmingly
 * strict-null noise that is NOT the bug and is not being fixed here. The
 * baseline is per file for both configs, never a single total — one new error
 * hiding behind one fixed error is exactly the move a total cannot see.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HUB_ROOT = join(import.meta.dir, "..", "..");
const BASELINE_FILE = join(HUB_ROOT, "typecheck-known-red.txt");
/** Only the `tests/` entries: `tsconfig.tests.json` compiles `src` too, and the
 *  two files are unioned below rather than repeating fifteen numbers. */
const TESTS_BASELINE_FILE = join(HUB_ROOT, "typecheck-known-red-tests.txt");

/** `src/routes/station-acp.ts(320,17): error TS2769: …` → `src/routes/station-acp.ts`. */
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
    if (!match) continue;
    counts[match[1]!] = (counts[match[1]!] ?? 0) + 1;
  }
  return counts;
}

async function runTypecheck(script = "typecheck"): Promise<string> {
  const proc = Bun.spawn(["bun", "run", script], {
    cwd: HUB_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return stdout + stderr;
}

describe("the documented typecheck baseline", () => {
  test("matches what the compiler actually reports", async () => {
    const actual = parseCompilerOutput(await runTypecheck());
    const documented = parseBaseline(readFileSync(BASELINE_FILE, "utf8"));

    // Compared as whole objects so the failure names every file that moved, in
    // both directions, rather than stopping at the first one.
    expect(actual).toEqual(documented);
  }, 180_000);

  test("the baseline file parses and is not empty", () => {
    // Guards the guard: a baseline emptied by a bad edit would make the
    // comparison above vacuous the moment the compiler went green for an
    // unrelated reason.
    const documented = parseBaseline(readFileSync(BASELINE_FILE, "utf8"));
    expect(Object.keys(documented).length).toBeGreaterThan(0);
    for (const [file, count] of Object.entries(documented)) {
      expect(file, "baseline paths are relative to apps/hub").toStartWith("src/");
      expect(count, `${file} must carry a positive error count`).toBeGreaterThan(0);
    }
  });
});

describe("the documented typecheck baseline, tests included", () => {
  test("matches what the compiler actually reports", async () => {
    const actual = parseCompilerOutput(await runTypecheck("typecheck:tests"));

    // Guards the guard, and the one that matters most here: a `tsconfig.tests.json`
    // that silently stopped including `tests/**\/*` would leave this comparing
    // `src` to `src` and pass while checking nothing — which is the failure the
    // whole file exists to close, reintroduced one level up.
    expect(
      Object.keys(actual).filter((f) => f.startsWith("tests/")).length,
      "the tests config really compiles tests/",
    ).toBeGreaterThan(10);

    const documented = {
      ...parseBaseline(readFileSync(BASELINE_FILE, "utf8")),
      ...parseBaseline(readFileSync(TESTS_BASELINE_FILE, "utf8")),
    };

    // Whole objects, so a failure names every file that moved in either
    // direction. Fewer errors than the baseline is good news that still turns
    // this red: update the file and say so in the diff.
    expect(actual).toEqual(documented);
  }, 300_000);

  test("the tests baseline parses, is not empty, and does not restate src", () => {
    const documented = parseBaseline(readFileSync(TESTS_BASELINE_FILE, "utf8"));
    expect(Object.keys(documented).length).toBeGreaterThan(10);
    for (const [file, count] of Object.entries(documented)) {
      // A `src/` row here would be a second, divergeable copy of a number the
      // file next door already owns.
      expect(file, "the tests baseline holds only tests/ paths").toStartWith("tests/");
      expect(count, `${file} must carry a positive error count`).toBeGreaterThan(0);
    }
  });

  test("the src baseline is untouched by the tests config", () => {
    // `bun run typecheck` and its count of 15 are a published claim that this
    // work was not allowed to move. Asserted here rather than trusted, because
    // the tests config extends the src one and a stray `compilerOptions`
    // override in it would change both at once.
    const src = parseBaseline(readFileSync(BASELINE_FILE, "utf8"));
    const total = Object.values(src).reduce((a, b) => a + b, 0);
    expect(total, "KNOWN-RED for src is 15 errors").toBe(15);
  });
});
