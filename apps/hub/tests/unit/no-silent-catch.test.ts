/**
 * No silent catch on the checkpoint path.
 *
 * Three times a catch on this path turned a failure into a quiet `unreported` or `unavailable`,
 * and each time the only symptom was an agent that stopped doing anything. So every catch in these
 * files must do one of:
 *
 * - log it: `noteCheckpoint`, a refusal log (`refuse`, `checkpointRefused`, `refused`), a quiet
 *   log, `log(...)`/`log.<level>(...)`, or `errorFacts`;
 * - rethrow the same error, or wrap it with the error as the `cause`, so the caller's log names it;
 * - or carry `// silent-catch-ok: <why>` on its line, for the few that decide nothing.
 *
 * And a checkpoint park always names its reason: `parked()` with no argument is refused.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKPOINT_PATH, COMPLETED_PATH, SOURCE_ROOT, catches, handled, unnamedParks, unnamedRefusals } from "../helpers/silent-catch";

const root = SOURCE_ROOT;

test("every catch on the checkpoint path logs, rethrows with its cause, or says why it may be silent", () => {
  const silent: string[] = [];
  for (const file of CHECKPOINT_PATH) {
    const source = readFileSync(join(root, file), "utf8");
    for (const c of catches(source)) if (!handled(c)) silent.push(`${file}:${c.line}  ${c.head.trim()}`);
  }
  expect(silent).toEqual([]);
});

test("a checkpoint park always names its reason", () => {
  const source = readFileSync(join(root, "services/bridge/checkpoint-dispatch.ts"), "utf8");
  expect(source.match(/\bparked\(\s*\)/g) ?? []).toEqual([]);
});

test("the detector itself finds a silent catch, and accepts the handled forms", () => {
  const silent = catches("try { a(); } catch { return parked(); }\nx.catch(() => {});");
  expect(silent.map(handled)).toEqual([false, false]);
  const fine = catches([
    "try { a(); } catch (error) { noteCheckpoint(\"s\", \"r\", {}, error); return x; }",
    "try { a(); } catch (error) { throw new CheckpointRefused(\"unavailable\", undefined, error); }",
    "try { a(); } catch (err) { if (y) throw err; log(\"m\", {}); }",
    "x.catch(() => {}); // silent-catch-ok: releasing a reader",
  ].join("\n"));
  expect(fine.map(handled)).toEqual([true, true, true, true]);
});

test("every refusal on the completed path names its closed reason", () => {
  const unnamed: string[] = [];
  for (const file of COMPLETED_PATH) {
    const source = readFileSync(join(root, file), "utf8");
    for (const r of unnamedRefusals(source)) unnamed.push(`${file}:${r.line}  ${r.text}`);
  }
  expect(unnamed).toEqual([]);
});

test("the unnamed-refusal detector finds a bare code and a reason left undefined, and accepts a named one", () => {
  const found = unnamedRefusals([
    'throw new CheckpointRefused("source");',
    'throw new CheckpointRefused( "stale" );',
    'throw new CheckpointRefused("authority", undefined, error);',
    'throw new CheckpointRefused(body === undefined ? "unavailable" : "uncertain");',
    'throw new CheckpointRefused("source", "settlement.unchanged");',
    'throw new CheckpointRefused("uncertain", nodeCallReason(e), error);',
    'const refuse = (why) => new CheckpointRefused("source", `settlement.${why}`, cause);',
  ].join("\n"));
  expect(found.map((r) => r.line)).toEqual([1, 2, 3, 4]);
});

test("every park in the orchestrator passes the error that names it", () => {
  const file = "services/bridge/checkpoint-orchestrator.ts";
  const source = readFileSync(join(root, file), "utf8");
  expect(unnamedParks(source).map((r) => `${file}:${r.line}  ${r.text}`)).toEqual([]);
  // The helper itself takes no default code and no optional error, so a bare call cannot type-check.
  expect(source).toMatch(/const parked = \(attempt: RetainedCheckpointAttempt, code: CheckpointRefused\["code"\], error: unknown\)/);
});

test("the unnamed-park detector finds a bare park and a code-only park, and accepts a named one", () => {
  const found = unnamedParks([
    "return parked(attempt);",
    'return parked(attempt, "uncertain");',
    "if (!receipt) return parked( attempt );",
    'return parked(attempt, "uncertain", new CheckpointRefused("uncertain", `node.state:${why}`));',
    'return parked(attempt, error instanceof CheckpointRefused ? error.code : "unavailable", error);',
    'return parked(attempt, "uncertain", undefined);',
  ].join("\n"));
  expect(found.map((r) => r.line)).toEqual([1, 2, 3, 6]);
});
