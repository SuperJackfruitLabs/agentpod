/**
 * How the checkpoint path says why it did not do something.
 *
 * Every catch, every error-to-status mapping and every park on this path names a closed reason
 * here, with the error's class and a redacted message, at most once per reason and error class
 * per interval (`quiet-log.ts`). `tests/unit/no-silent-catch.test.ts` holds the path to it.
 */
import { createLogger } from "../../utils/logger";
import { createQuietLog, type QuietLog } from "./quiet-log";
import type { CheckpointRefusalReason } from "./checkpoint-profile";

/** The broker's transport failure, as a closed reason. Its free-text error goes to the log only. */
export function nodeCallReason(error: string): CheckpointRefusalReason {
  if (error === "timeout") return "node.call.timeout";
  if (error === "node offline") return "node.call.offline";
  return "node.call.error";
}

const log = createLogger("bridge-checkpoint");
let quiet: QuietLog = createQuietLog((message, meta) => log.warn(message, meta));

/** Test seam: route the checkpoint log elsewhere. Returns the restore. */
export function setCheckpointLogForTests(next: QuietLog): () => void {
  const prior = quiet;
  quiet = next;
  return () => { quiet = prior; };
}

/**
 * A message with anything credential-shaped removed: bearer values, `spa_`/`svc_`/`sk_` tokens,
 * `id:secret` service credentials, JWTs and long hex runs. Bounded, so a body cannot ride along.
 */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(spa|svc|sk|pk|rk)_[A-Za-z0-9]+(:[^\s"']+)?/g, "$1_[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[jwt]")
    .replace(/[A-Fa-f0-9]{40,}/g, "[hex]")
    .slice(0, 300);
}

/** The error's class, its redacted message, and any closed code it carries. Never its stack or cause chain. */
export function errorFacts(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorClass: typeof error, error: redact(String(error)) };
  const facts: Record<string, unknown> = { errorClass: error.name || error.constructor.name, error: redact(error.message) };
  for (const key of ["code", "reason", "status"] as const) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === "string" || typeof value === "number") facts[key === "code" ? "errorCode" : key === "reason" ? "errorReason" : "status"] = value;
  }
  return facts;
}

/**
 * Name why the checkpoint path did not proceed. `reason` is a closed word chosen at the call site;
 * `error`, when there is one, adds its class and redacted message. Logged once per site, reason and
 * error class, then once per interval with the count suppressed.
 */
export function noteCheckpoint(site: string, reason: string, meta: Record<string, unknown> = {}, error?: unknown): void {
  const facts = error === undefined ? {} : errorFacts(error);
  quiet([site, reason, String(facts.errorClass ?? "")].join("\0"), `checkpoint ${site}: ${reason}`,
    { site, reason, ...meta, ...facts });
}
