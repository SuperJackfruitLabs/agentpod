/**
 * Audit service — records terminal and write-op events to station_audit.
 *
 * Usage:
 *   const handle = await recordAudit(db, { userId, nodeId, stationKey, verb, params });
 *   // ... perform the operation ...
 *   await handle.done("ok");          // success
 *   await handle.done("error", msg);  // failure
 *
 * paramsSummary is a sanitised copy of params that strips large / sensitive
 * fields (file content, terminal keystrokes, secrets) and retains only safe
 * identifiers such as paths, action names, and sizes.
 *
 * Filled in P2 Task 6.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db/drizzle";
import { stationAudit } from "../db/schema/audit";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditArgs {
  userId: string;
  nodeId: string;
  stationKey: string;
  verb: string;
  params: Record<string, unknown>;
}

export interface AuditHandle {
  done(result: "ok" | "error", error?: string): Promise<void>;
}

// ─── Param sanitiser ──────────────────────────────────────────────────────────

/**
 * Keys that are safe to store in the audit log.
 *
 * Rule: NEVER include file content, terminal input/output, or any field whose
 * value could contain secrets or PII.  Store only structural identifiers and
 * small scalar metadata.
 */
const SAFE_PARAM_KEYS = new Set<string>([
  "path",
  "from",
  "to",
  "action",
  "paths",
  "key",
  "stationKey",
  "cols",
  "rows",
  "sessionId",
  "recursive",
  "encoding",
  "backup",
  "kind",
  "size",
  "totalBytes",
  "chars",
  "pathCount",
]);

/**
 * Returns a copy of `params` with sensitive / large fields removed.
 *
 * Uses an explicit allowlist so newly-added params are blocked by default
 * rather than accidentally logged.
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SAFE_PARAM_KEYS.has(k)) {
      safe[k] = v;
    }
  }
  return safe;
}

// ─── recordAudit ──────────────────────────────────────────────────────────────

/**
 * Insert a station_audit row with result:"pending" and return a handle whose
 * `done` method finalises the result once the operation completes.
 *
 * @param db      The Drizzle database handle (import from "../db/drizzle").
 * @param args    Audit context: who did what, where.
 */
export async function recordAudit(
  db: Database,
  args: AuditArgs
): Promise<AuditHandle> {
  const id = `audit_${crypto.randomUUID()}`;
  const paramsSummary = sanitizeParams(args.params);

  await db.insert(stationAudit).values({
    id,
    userId: args.userId,
    nodeId: args.nodeId,
    stationKey: args.stationKey,
    verb: args.verb,
    paramsSummary,
    result: "pending",
    error: null,
    createdAt: new Date(),
  });

  return {
    async done(result: "ok" | "error", error?: string): Promise<void> {
      await db
        .update(stationAudit)
        .set({
          result,
          error: error ?? null,
        })
        .where(eq(stationAudit.id, id));
    },
  };
}
