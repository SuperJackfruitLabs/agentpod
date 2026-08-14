/**
 * The bridge's two durable facts.
 *
 * **The run join.** `startAttempt` is `acp_runs`' first writer — no statement
 * inserting into that table exists at any commit in this repository, and
 * production holds zero rows. What it writes is the paired fact the CHECK
 * enforces: `external_run_id` is kaambaan's work run and `external_source` says
 * who minted it. The row's own id is `attempt_<uuid>`: AgentPod executes work
 * runs, it does not mint them, and one claimed card takes as many prompt-turns
 * as the work takes.
 *
 * **The at-least-once ledger.** Reclaim re-dispatches a finished-but-unreported
 * run — spike RQ4 watched a harness finish at t+180s and the board hand the same
 * card to a second agent at t+900s, because the bridge died before calling
 * `complete`. That was judged the *likely* production failure: not a race, just
 * silently repeated work. So `recordProduced` writes the output down **before**
 * the report is attempted, and `findUnreportedOutput` is how the next claim of
 * the same card finds it instead of doing it again.
 *
 * Both writes carry `tenant_id`, and every read is scoped by it through
 * `tenantScope` — a lookup keyed on a board and a card that crossed a tenant
 * boundary would replay one organisation's work onto another's card.
 */

import { and, desc, eq, ne } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { acpRuns } from "../../db/schema/acp";
import { bridgeDispatches, type DispatchOutcome } from "../../db/schema/bridge";
import { tenantScope } from "../../db/tenant-scope";

/** Everything that identifies one dispatched work run. */
export interface DispatchKey {
  tenantId: string;
  /** The orchestrator that minted `externalRunId`. */
  externalSource: string;
  boardId: string;
  externalCardId: string;
  externalRunId: string;
}

export interface OpenDispatchInput extends DispatchKey {
  agentKey: string;
  stationId: string;
  leaseEpoch: number;
}

export interface StartAttemptInput extends DispatchKey {
  sessionId: string;
  stationId: string;
  /** `acp_events.seq` of the prompt that opened this attempt. */
  startSeq: number;
}

export interface PriorOutput {
  externalRunId: string;
  result: unknown;
  acpRunId: string | null;
}

/** AgentPod's own id space. Never `run_`, which is kaambaan's. */
const mintAttemptId = (): string => `attempt_${crypto.randomUUID()}`;

const scope = (key: DispatchKey) =>
  tenantScope(
    bridgeDispatches,
    key.tenantId,
    eq(bridgeDispatches.externalSource, key.externalSource),
    eq(bridgeDispatches.externalRunId, key.externalRunId),
  );

/**
 * Record a claim. Idempotent on `(externalSource, externalRunId)`: a hub that
 * restarts and is handed the same run back updates its lease rather than
 * duplicating the row — and the lease is what every subsequent verb echoes, so
 * a stale copy would be worse than no row at all.
 */
export async function openDispatch(input: OpenDispatchInput): Promise<void> {
  const now = new Date();
  await db
    .insert(bridgeDispatches)
    .values({
      externalSource: input.externalSource,
      externalRunId: input.externalRunId,
      tenantId: input.tenantId,
      boardId: input.boardId,
      externalCardId: input.externalCardId,
      agentKey: input.agentKey,
      stationId: input.stationId,
      leaseEpoch: input.leaseEpoch,
      outcome: "working",
      startedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [bridgeDispatches.externalSource, bridgeDispatches.externalRunId],
      set: { leaseEpoch: input.leaseEpoch, outcome: "working", reason: null, updatedAt: now },
    });
}

/**
 * Open the attempt that executes a dispatched run: the `acp_runs` row, and the
 * dispatch's pointer at it. Returns the attempt id.
 */
export async function startAttempt(input: StartAttemptInput): Promise<string> {
  if (input.externalRunId.startsWith("attempt_")) {
    // The CHECK would catch this, but a writer that gets that far has already
    // decided a hub's own key is a board's work run. Refuse it where the
    // mistake is legible.
    throw new Error(
      `startAttempt: externalRunId ${input.externalRunId} is one of AgentPod's own attempt ids, not an orchestrator's work run`,
    );
  }

  const id = mintAttemptId();
  const now = new Date();
  await db.insert(acpRuns).values({
    id,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    stationId: input.stationId,
    // One fact, two columns. The pair is what makes the row joinable from the
    // board's side through acp_runs_external_idx.
    externalRunId: input.externalRunId,
    externalSource: input.externalSource,
    state: "working",
    startSeq: input.startSeq,
    startedAt: now,
  });

  await db.update(bridgeDispatches).set({ acpRunId: id, updatedAt: now }).where(scope(input));
  return id;
}

/** Close an attempt. `state` is A2A's vocabulary, shared with kaambaan verbatim. */
export async function endAttempt(attemptId: string, state: string, endSeq: number | null): Promise<void> {
  await db
    .update(acpRuns)
    .set({ state, endSeq, endedAt: new Date() })
    .where(eq(acpRuns.id, attemptId));
}

/**
 * The work finished and this is what it produced — written **before** the board
 * is told, so a bridge that dies between the two leaves a recoverable fact
 * rather than a card that will be worked twice.
 */
export async function recordProduced(key: DispatchKey, result: unknown): Promise<void> {
  await db
    .update(bridgeDispatches)
    .set({ outcome: "produced", result: result ?? null, updatedAt: new Date() })
    .where(scope(key));
}

/** The board has been told. Nothing to replay. */
export async function markReported(key: DispatchKey): Promise<void> {
  await setOutcome(key, "reported", null);
}

/**
 * The claim was handed back to the board before any session opened.
 *
 * Its own outcome, not a flavour of `abandoned`: this row says the workspace
 * cannot have been touched, which is the fact that makes handing the card
 * straight back safe. `acp_run_id` cannot say it — that column is written on the
 * first ACP event, so a session that opened and died before emitting one leaves
 * it null as well.
 */
export async function markReleased(key: DispatchKey, reason: string): Promise<void> {
  await setOutcome(key, "released", reason);
}

/**
 * No report will be made for this run — the lease was superseded, or the run
 * turned out to be another agent's. Deliberately NOT `produced`: replaying a
 * half-finished handoff onto whoever holds the card now would report work this
 * bridge cannot vouch for.
 */
export async function markAbandoned(key: DispatchKey, reason: string): Promise<void> {
  await setOutcome(key, "abandoned", reason);
}

async function setOutcome(key: DispatchKey, outcome: DispatchOutcome, reason: string | null): Promise<void> {
  await db.update(bridgeDispatches).set({ outcome, reason, updatedAt: new Date() }).where(scope(key));
}

/**
 * Did an earlier run of this card finish without the board being told?
 *
 * Keyed on the **card**, not the run, because a reclaim mints a new run id for
 * the same work — which is exactly why "make the work idempotent" is not
 * available here: a harness edits a workspace and runs commands, and no amount
 * of care makes the second execution of that a no-op. Checking is the only
 * honest option, and this is the check.
 *
 * The run being dispatched now is excluded, or the recovery path is a loop.
 */
export async function findUnreportedOutput(key: DispatchKey): Promise<PriorOutput | null> {
  const rows = await db
    .select({
      externalRunId: bridgeDispatches.externalRunId,
      result: bridgeDispatches.result,
      acpRunId: bridgeDispatches.acpRunId,
    })
    .from(bridgeDispatches)
    .where(
      tenantScope(
        bridgeDispatches,
        key.tenantId,
        eq(bridgeDispatches.externalSource, key.externalSource),
        eq(bridgeDispatches.boardId, key.boardId),
        eq(bridgeDispatches.externalCardId, key.externalCardId),
        eq(bridgeDispatches.outcome, "produced"),
        ne(bridgeDispatches.externalRunId, key.externalRunId),
      ),
    )
    .orderBy(desc(bridgeDispatches.updatedAt))
    .limit(1);

  return rows[0] ?? null;
}

/** Test seam: the outcome currently recorded for a run. */
export async function dispatchOutcome(key: DispatchKey): Promise<{ outcome: string; reason: string | null } | null> {
  const rows = await db
    .select({ outcome: bridgeDispatches.outcome, reason: bridgeDispatches.reason })
    .from(bridgeDispatches)
    .where(and(scope(key)));
  return rows[0] ?? null;
}
