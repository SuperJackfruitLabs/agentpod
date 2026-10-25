/**
 * Audit service — records terminal and write-op events to station_audit.
 *
 * Usage:
 *   const handle = await recordAudit(db, { tenantId, userId, nodeId, stationKey, verb, params });
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
import type { DbExecutor } from "../db/drizzle";
import { stationAudit } from "../db/schema/audit";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditArgs {
  /**
   * The tenant of the row the action is on (the station's or node's), or the
   * request's when there is none. Never derived from `userId` (W5).
   */
  tenantId: string;
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
export const SAFE_PARAM_KEYS: ReadonlySet<string> = new Set<string>([
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
  // evidence.transcript.read (routes/evidence.ts): what was read and by whom, never the content.
  "seq_from",
  "seq_to",
  "items",
  "redactions",
  "full",
  "item_seq",
  "on_behalf_of",
  // forge API grants (routes/station-forge-api.ts): ids and enums only — never the sealed blob,
  // the token handle or a token. `actor` is the acting user, repeated in params because the row's
  // own user_id is what the tenant is resolved from.
  "actor",
  "grantId",
  "provider",
  "mode",
  "preset",
  "generation",
  "username",
  "outcome",
  // agent approval rules (routes/agent-approval-rules.ts): ids and the scope only.
  "ruleId",
  "scope",
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
  db: DbExecutor,
  args: AuditArgs
): Promise<AuditHandle> {
  const id = `audit_${crypto.randomUUID()}`;
  const paramsSummary = sanitizeParams(args.params);

  await db.insert(stationAudit).values({
    id,
    tenantId: args.tenantId,
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
