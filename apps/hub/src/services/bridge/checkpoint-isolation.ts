/**
 * A checkpoint refusal is scoped to checkpoint work. It never ends the agent's claim cycle:
 * the cycle continues with ordinary claims, which the board never answers with a checkpoint
 * stage (a claim without the checkpoint protocol cannot select one). What authority requires
 * is unchanged here; this only decides how far a refusal reaches and how often it is logged.
 */
import { CheckpointRefused, type CheckpointRefusalReason } from "./checkpoint-profile";
import type { CheckpointDispatchPort } from "./checkpoint-dispatch";
import type { SuperpipelineClient } from "./superpipeline";
import { errorFacts } from "./checkpoint-log";

/** The error a refusal stands for: its own cause when it replaced one, else itself when it is not a refusal. */
function underlying(error: unknown): unknown {
  if (error instanceof CheckpointRefused) return error.cause;
  return error;
}

/** How long a repeated refusal with the same reason stays quiet before it is logged again. */
export const CHECKPOINT_REFUSAL_RELOG_MS = 15 * 60_000;

export type CheckpointRefusalLog = (error: unknown) => void;

/** The refusal's own reason code; anything else on the checkpoint path is "unavailable". */
export function checkpointRefusalCode(error: unknown): string {
  return error instanceof CheckpointRefused ? error.code : "unavailable";
}

/** The refusal's closed sub-reason, when it names one. Never on the wire; for this log only. */
export function checkpointRefusalReason(error: unknown): CheckpointRefusalReason | undefined {
  return error instanceof CheckpointRefused ? error.reason : undefined;
}

/**
 * Logs a refusal once per distinct reason (its code and, when it names one, its sub-reason), then again at most once per `relogMs` with the count
 * it suppressed meanwhile. A claim cycle every few seconds must not become a log line every few
 * seconds forever. Neither raw exceptions nor private profile fields enter the line.
 */
export function createCheckpointRefusalLog(
  log: (message: string, meta?: Record<string, unknown>) => void,
  opts: { now?: () => number; relogMs?: number } = {},
): CheckpointRefusalLog {
  const now = opts.now ?? Date.now;
  const relogMs = opts.relogMs ?? CHECKPOINT_REFUSAL_RELOG_MS;
  const seen = new Map<string, { at: number; suppressed: number }>();
  return (error) => {
    const code = checkpointRefusalCode(error);
    const reason = checkpointRefusalReason(error);
    // An error that is not a closed refusal (or a refusal that replaced one) is named by its class
    // and redacted message, so "unavailable" is never the whole story.
    const cause = underlying(error);
    const facts = cause === undefined ? {} : errorFacts(cause);
    const key = [code, reason ?? "", String(facts.errorClass ?? "")].join("\0");
    const at = now();
    const last = seen.get(key);
    if (last && at - last.at < relogMs) {
      last.suppressed++;
      return;
    }
    seen.set(key, { at, suppressed: 0 });
    log("checkpoint dispatch refused; ordinary claims continue", {
      code,
      ...(reason === undefined ? {} : { reason }),
      ...facts,
      ...(last ? { suppressed: last.suppressed } : {}),
    });
  };
}

/**
 * The client and port one claim cycle uses. A refused checkpoint client leaves the cycle with the
 * agent's ordinary roster client and no checkpoint port, exactly as an agent with no profile.
 */
export async function checkpointCycle(
  dedicated: { client(): Promise<SuperpipelineClient>; port: CheckpointDispatchPort } | undefined,
  ordinary: SuperpipelineClient,
  refused: CheckpointRefusalLog,
): Promise<{ client: SuperpipelineClient; checkpoint?: CheckpointDispatchPort }> {
  if (!dedicated) return { client: ordinary };
  try {
    return { client: await dedicated.client(), checkpoint: dedicated.port };
  } catch (error) {
    refused(error);
    return { client: ordinary };
  }
}
