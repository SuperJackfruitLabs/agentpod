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
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HUB_ROOT = join(import.meta.dir, "..", "..");
const BASELINE_FILE = join(HUB_ROOT, "typecheck-known-red.txt");

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

async function runTypecheck(): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "typecheck"], {
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
