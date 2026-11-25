/**
 * Unresolved checkpoint attempts, as an operator surface: inspect them, and settle one explicitly.
 *
 * Mounted inside `/api/admin`, so only an owner or admin of the workspace reaches it, and every
 * read and write is that workspace's rows alone.
 *
 * The Hub retires a superseded attempt by itself only when the ledger and the node prove nothing
 * is outstanding (`services/bridge/checkpoint-supersede.ts`). Everything else stays parked until a
 * person settles it here, with evidence: what they checked (the node's journal, the bench, the
 * board) and why nothing is left running. Settling never deletes the row or any evidence in it;
 * it ends the attempt as `retired` with the operator's statement beside what was already recorded,
 * and the Hub then answers the node `stale_owner` for it, so the node retires its own record too.
 * A remote bench stage's agent stops at once, as on every other exit: its turn is cancelled, the
 * station's sessions are ended and the station detached (a detach that fails is the sweep's).
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { resolveTenantId } from "../auth/tenant";
import { logAdminAction } from "../models/admin-audit-log";
import { request as nodeRequest } from "../services/broker";
import { canonicalCheckpoint, CHECKPOINT_TERMINAL_PHASES, checkpointProfileSuperseded, endRemoteWork, NO_PRODUCER_EFFECT_PHASES,
  readCheckpointAttempt, retireCheckpointAttempt, unresolvedCheckpointAttempts } from "../services/bridge";

const settleSchema = z.object({
  /** The attempt id again: a settlement names exactly what it settles. */
  confirm: z.string().min(1),
  /** What the operator checked, and why nothing it started is still outstanding. */
  evidence: z.string().trim().min(20).max(4000),
}).strict();

export const adminCheckpointAttemptsRouter = new Hono()
  .get("/", async (c) => {
    const tenantId = resolveTenantId(c);
    const rows = await unresolvedCheckpointAttempts(tenantId);
    const attempts = await Promise.all(rows.map(async (row) => {
      let superseded: boolean | null = null;
      try {
        const attempt = await readCheckpointAttempt(tenantId, row.attemptId);
        superseded = attempt ? checkpointProfileSuperseded(attempt.profile) : null;
      } catch { superseded = null; }
      return { attemptId: row.attemptId, boardId: row.boardId, runId: row.runId, leaseEpoch: row.leaseEpoch,
        phase: row.phase, superseded, effectPossible: !NO_PRODUCER_EFFECT_PHASES.has(row.phase),
        createdAt: row.createdAt, updatedAt: row.updatedAt };
    }));
    return c.json({ attempts });
  })
  .post("/:attemptId/settle", zValidator("json", settleSchema), async (c) => {
    const tenantId = resolveTenantId(c);
    const attemptId = c.req.param("attemptId");
    const { confirm, evidence } = c.req.valid("json");
    if (confirm !== attemptId) return c.json({ error: "confirm must repeat the attempt id being settled" }, 400);
    const attempt = await readCheckpointAttempt(tenantId, attemptId).catch(() => undefined);
    if (!attempt) return c.json({ error: "no such checkpoint attempt in this workspace" }, 404);
    if (CHECKPOINT_TERMINAL_PHASES.has(attempt.row.phase))
      return c.json({ error: `the attempt is already ${attempt.row.phase}` }, 409);
    const userId = c.get("user").id;
    const settled = await retireCheckpointAttempt(attempt, { reason: "operator", by: userId, evidence });
    if (!settled) return c.json({ error: "the attempt moved on while it was being settled; read it again" }, 409);
    const retired = await readCheckpointAttempt(tenantId, attemptId).catch(() => undefined);
    if (retired) await endRemoteWork(retired, { request: nodeRequest }, "An operator settled the bench stage's attempt.");
    await logAdminAction({ tenantId, adminUserId: userId, action: "checkpoint_attempt_settle",
      targetResourceId: attemptId, targetResourceType: "checkpoint_attempt",
      details: { from: attempt.row.phase, boardId: attempt.row.boardId, runId: attempt.row.runId,
        retirement: canonicalCheckpoint({ reason: "operator", evidence }) } });
    return c.json({ attemptId, from: attempt.row.phase, phase: "retired" });
  });
