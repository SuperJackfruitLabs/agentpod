/** The silent-catch detector, shared by tests/unit/no-silent-catch.test.ts and the PR audit. */
import { join } from "node:path";

export const SOURCE_ROOT = join(import.meta.dir, "../../src");
export const CHECKPOINT_PATH = [
  "services/bridge/checkpoint-dispatch.ts", "services/bridge/checkpoint-port.ts", "services/bridge/checkpoint-current.ts",
  "services/bridge/checkpoint-isolation.ts", "services/bridge/checkpoint-agent-client.ts", "services/bridge/dispatch-run.ts",
  "services/bridge/loop.ts", "services/bridge/plane-credential.ts", "services/bridge/checkpoint-orchestrator.ts",
  "services/bridge/checkpoint-supersede.ts", "services/bridge/checkpoint-service-client.ts",
  "services/bridge/checkpoint-current-decision.ts", "services/bridge/checkpoint-profiles.ts",
  "services/bridge/checkpoint-ledger.ts", "services/bridge/checkpoint-log.ts", "services/broker/broker.ts",
  "services/bridge/checkpoint-activity.ts", "services/bridge/checkpoint-run-ended.ts",
];

/** A call that says something: the checkpoint log, a refusal log handed the error, a quiet or plain log. */
const SAYS = [/\bnoteCheckpoint\(/, /\brefuse\(/, /\bcheckpointRefused\(/, /\brefused\((error|err)\)/, /\bquiet\(/,
  /\bparkedLog\(/, /\bsupersededLog\(/, /\blog\(/, /\blog\.(info|warn|error)\(/, /\berrorFacts\(/,
  /\bparked\([^)]*\b(error|err)\)/];
/** A throw that hands the error on: rethrown as is, or wrapped with it as the cause. */
const PASSES_ON = /^throw (error|err)$|,\s*(error|err)\)$/;

/** Every catch in `source`: its line and the text that handles it (a block body or a `.catch` argument). */
export function catches(source: string): Array<{ line: number; head: string; body: string }> {
  const found: Array<{ line: number; head: string; body: string }> = [];
  const pattern = /\bcatch\b\s*(\([^)]*\))?\s*\{|\.catch\(/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const open = match[0].endsWith("{") ? "{" : "(";
    const close = open === "{" ? "}" : ")";
    let depth = 1; let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === open) depth++;
      else if (source[i] === close) depth--;
    }
    const line = source.slice(0, match.index).split("\n").length;
    found.push({ line, head: source.split("\n")[line - 1] ?? "", body: source.slice(match.index + match[0].length, i - 1) });
  }
  return found;
}

/** Whether a catch is handled (not silent). */
export function handled(c: { head: string; body: string }): boolean {
  if (/silent-catch-ok:/.test(c.head) || /silent-catch-ok:/.test(c.body)) return true;
  if (SAYS.some((p) => p.test(c.body))) return true;
  // Otherwise it must only hand the error on: every throw passes it, and nothing returns instead.
  const throws = (c.body.match(/\bthrow\b[^;}]*/g) ?? []).map((t) => t.trim());
  return throws.length > 0 && throws.every((t) => PASSES_ON.test(t)) && !/\breturn\b/.test(c.body);
}


/**
 * The files a completed attempt runs through: the orchestrator's completed, submission and reported
 * phases, the settlement builder and its checks, the source projection and the ledger. A refusal
 * thrown here parks or ends the attempt, so it must say why: a staging attempt sat parked for an hour
 * as a bare `source` because the settlement builder named nothing.
 */
export const COMPLETED_PATH = [
  "services/bridge/checkpoint-orchestrator.ts", "services/bridge/checkpoint-report.ts", "services/bridge/checkpoint-settlement-data.ts",
  "services/bridge/checkpoint-source.ts", "services/bridge/checkpoint-current-decision.ts", "services/bridge/checkpoint-ledger.ts",
  "services/bridge/checkpoint-service-client.ts", "services/bridge/checkpoint-run-ended.ts",
];

/** Every `new CheckpointRefused(...)` in `source` that names no reason: its line and text. */
export function unnamedRefusals(source: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  const pattern = /new CheckpointRefused\(\s*([^,()]+?)\s*(?:\)|,\s*undefined\b)/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source))
    found.push({ line: source.slice(0, match.index).split("\n").length, text: match[0] });
  return found;
}

/**
 * Every `parked(...)` call in `source` that passes no naming error: its line and text. A park with no
 * reason logged `execute_pending`/`uncertain` and nothing else while a killed run held its card.
 */
export function unnamedParks(source: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  const pattern = /\bparked\(\s*([^,()]+?)\s*(?:,\s*([^,()]+?|[^,()]*\([^()]*\)[^,()]*?)\s*)?\)/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source))
    found.push({ line: source.slice(0, match.index).split("\n").length, text: match[0] });
  const undefinedError = /\bparked\([^;]*?,\s*undefined\s*\)/g;
  for (let match = undefinedError.exec(source); match; match = undefinedError.exec(source))
    found.push({ line: source.slice(0, match.index).split("\n").length, text: match[0] });
  return found.toSorted((a, b) => a.line - b.line);
}
