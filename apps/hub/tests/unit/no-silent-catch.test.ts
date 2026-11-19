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
import { CHECKPOINT_PATH, SOURCE_ROOT, catches, handled } from "../helpers/silent-catch";

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
