/**
 * When a card's bench is cleared (ruling 2026-11-23).
 *
 * One card keeps one bench, handed from stage to stage and across review bounces, so cooperating
 * agents find it warm. A settlement clears nothing. The bench is cleared when the card:
 *
 * - is finished: its state is `completed`. A card that arrives at a last stage nobody can act on
 *   is resolved `completed` on arrival by the board, so that arrival is this case too;
 * - reaches a terminal state: `rejected` or `failed`. A last stage that still has work (a run to
 *   do, a review or checks to pass) is not terminal: the card can still bounce;
 * - is cancelled: `canceled`, archived, or deleted (the board answers 404 for its run);
 * - stays dormant: neither the card nor any of its attempts changed for `BENCH_DORMANT_AFTER_HOURS`.
 *
 * A sweep every few minutes reads each benched card through its latest run (`GET runs/:id`, which
 * returns the card as it is now, on the run scope every station already holds) and asks each node
 * the card used to reclaim the card's bench. Never for a card with an attempt still in progress;
 * the node refuses a held lease or an unsettled journal itself. A failed or refused reclaim only
 * logs, and the next sweep asks again. A stage set `--keep-bench` is never cleared by the hub.
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../db/drizzle";
import { benchClearances } from "../../db/schema/bench-clearances";
import { checkpointDispatches } from "../../db/schema/checkpoint-dispatch";
import { createLogger } from "../../utils/logger";
import { checkpointAgentClient } from "./checkpoint-agent-client";
import { CHECKPOINT_TERMINAL_PHASES, checkedCheckpointAttempt, type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { reclaimCardBench, stageKeepsBench, type ReclaimOutcome, type ReclaimTarget } from "./checkpoint-reclaim";
import { SuperpipelineApiError } from "./superpipeline";

const log = createLogger("bench-clearing");

export const BENCH_DORMANT_ENV = "BENCH_DORMANT_AFTER_HOURS";
/** A review left over a weekend keeps its bench. */
export const DEFAULT_DORMANT_HOURS = 72;
const MAX_DORMANT_HOURS = 8760;
export const CLEARING_INTERVAL_MS = 5 * 60_000;
/** Board reads per sweep, so a backlog is worked through over several sweeps rather than in one burst. */
export const CARDS_PER_SWEEP = 25;
/** A dormant card whose bench no node would clear for this long is left to SuperBench's idle sweep. */
export const ABANDON_AFTER_MS = 30 * 24 * 3_600_000;

export type ClearingReason = "completed" | "terminal" | "cancelled" | "dormant";

/** The dormancy limit in ms from `BENCH_DORMANT_AFTER_HOURS`: whole hours, 0 turns dormancy off. */
export function dormantAfterMs(raw: string | undefined = process.env.BENCH_DORMANT_AFTER_HOURS): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_DORMANT_HOURS * 3_600_000;
  const hours = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(hours) || hours > MAX_DORMANT_HOURS) {
    log.warn(`${BENCH_DORMANT_ENV} is not a whole number of hours from 0 to ${MAX_DORMANT_HOURS}; using the default`,
      { default: DEFAULT_DORMANT_HOURS });
    return DEFAULT_DORMANT_HOURS * 3_600_000;
  }
  return hours * 3_600_000;
}

/** The card as the board says it is now, read through one of its runs. */
export type CardRead =
  | { kind: "card"; state: string; archived: boolean; updatedAtMs?: number }
  /** 404 RUN_NOT_FOUND or CARD_NOT_FOUND: the card was deleted, and its runs with it. */
  | { kind: "gone"; code: string }
  /** No definite answer: a 5xx, a timeout, another agent's run, a body that does not parse. */
  | { kind: "unknown" };

const short = z.string().max(128);
const runCardView = z.object({
  run: z.object({ runId: short, cardId: short }).passthrough(),
  card: z.object({ id: short, state: z.string().max(32), archivedAt: z.string().max(64).nullable().optional(),
    updatedAt: z.string().max(64).optional() }).passthrough(),
}).passthrough();

/** The board's run view as a card read. Anything not about this run and card is no answer. Exported for tests. */
export function cardReadFromView(value: unknown, runId: string, cardId: string): CardRead {
  const parsed = runCardView.safeParse(value);
  if (!parsed.success) return { kind: "unknown" };
  const { run, card } = parsed.data;
  if (run.runId !== runId || run.cardId !== cardId || card.id !== cardId) return { kind: "unknown" };
  const updated = card.updatedAt ? Date.parse(card.updatedAt) : NaN;
  return { kind: "card", state: card.state, archived: !!card.archivedAt, ...(Number.isFinite(updated) ? { updatedAtMs: updated } : {}) };
}

/** A board refusal as a card read: only the exact 404s mean the card is gone. Exported for tests. */
export function cardReadFromError(error: unknown): CardRead {
  if (error instanceof SuperpipelineApiError && error.status === 404 && (error.code === "RUN_NOT_FOUND" || error.code === "CARD_NOT_FOUND"))
    return { kind: "gone", code: error.code };
  return { kind: "unknown" };
}

/**
 * Whether the card's bench should be cleared now, and why. `lastAttemptMs` is the newest change to
 * any of the card's attempts; the card's own `updatedAt` counts too when the board answered.
 */
export function clearingReason(read: CardRead, lastAttemptMs: number, nowMs: number, dormantMs: number): ClearingReason | undefined {
  if (read.kind === "gone") return "cancelled";
  if (read.kind === "card") {
    if (read.state === "completed") return "completed";
    if (read.state === "rejected" || read.state === "failed") return "terminal";
    if (read.state === "canceled" || read.archived) return "cancelled";
  }
  if (dormantMs <= 0) return undefined;
  const last = Math.max(lastAttemptMs, read.kind === "card" ? read.updatedAtMs ?? 0 : 0);
  return nowMs - last >= dormantMs ? "dormant" : undefined;
}

/** One checkpoint attempt of a benched card. `source` is what the real effects need; tests carry none. */
export interface CardAttempt<T = RetainedCheckpointAttempt> {
  tenantId: string; boardId: string; cardId: string; stationId: string; nodeId: string; runId: string;
  attemptId: string; phase: string; createdAtMs: number; updatedAtMs: number;
  source: T;
}

/** Every attempt of one card that the hub has not recorded as cleared. */
export interface BenchedCard<T = RetainedCheckpointAttempt> { attempts: CardAttempt<T>[] }

export interface ClearingDeps<T = RetainedCheckpointAttempt> {
  /** Every card with an attempt not yet recorded as cleared, grouped by card. */
  cards(): Promise<BenchedCard<T>[]>;
  /** The card as the board says it is now, read through this attempt's run. Never throws. */
  readCard(attempt: CardAttempt<T>): Promise<CardRead>;
  /** Whether this attempt's stage keeps its benches (`--keep-bench`). */
  keepBench(attempt: CardAttempt<T>): Promise<boolean>;
  reclaim(target: ReclaimTarget, reason: ClearingReason): Promise<ReclaimOutcome>;
  record(attempts: CardAttempt<T>[], reason: ClearingReason, outcome: "reclaimed" | "absent" | "abandoned"): Promise<void>;
  now(): number;
  dormantMs: number;
}

export interface CardClearing { cardId: string; outcome: "warm" | "unsettled" | "kept" | "cleared" | "retry" | "abandoned"; reason?: ClearingReason }

const latest = <T>(attempts: CardAttempt<T>[]) =>
  attempts.reduce((a, b) => (b.createdAtMs > a.createdAtMs || (b.createdAtMs === a.createdAtMs && b.attemptId > a.attemptId) ? b : a));

/** Judge one card and, when it is done, cancelled or dormant, clear its bench on every node it used. */
export async function clearCardBench<T>(card: BenchedCard<T>, deps: ClearingDeps<T>): Promise<CardClearing> {
  const newest = latest(card.attempts);
  const facts = { tenantId: newest.tenantId, boardId: newest.boardId, cardId: newest.cardId };
  // An attempt still in progress owns the bench: never cleared under it.
  if (card.attempts.some((a) => !CHECKPOINT_TERMINAL_PHASES.has(a.phase))) return { cardId: newest.cardId, outcome: "unsettled" };
  // Each node the card used, by the newest attempt there; a node whose stage keeps its benches is left alone.
  const byNode = new Map<string, CardAttempt<T>>();
  for (const a of card.attempts) {
    const seen = byNode.get(a.nodeId);
    if (!seen || latest([seen, a]) === a) byNode.set(a.nodeId, a);
  }
  const nodes: CardAttempt<T>[] = [];
  for (const a of byNode.values()) if (!(await deps.keepBench(a))) nodes.push(a);
  if (nodes.length === 0) return { cardId: newest.cardId, outcome: "kept" };

  const lastAttemptMs = Math.max(...card.attempts.map((a) => a.updatedAtMs));
  const read = await deps.readCard(newest);
  const reason = clearingReason(read, lastAttemptMs, deps.now(), deps.dormantMs);
  if (!reason) return { cardId: newest.cardId, outcome: "warm" };

  const outcomes: ReclaimOutcome[] = [];
  for (const a of nodes) {
    outcomes.push(await deps.reclaim({ nodeId: a.nodeId, tenantId: a.tenantId, boardId: a.boardId, stationId: a.stationId, cardId: a.cardId }, reason));
  }
  const kept = nodes.length < byNode.size;
  if (outcomes.every((o) => o === "reclaimed" || o === "absent")) {
    // A node whose stage keeps its benches still holds one: its attempts stay to be judged again.
    const done = kept ? card.attempts.filter((a) => nodes.some((n) => n.nodeId === a.nodeId)) : card.attempts;
    await deps.record(done, reason, outcomes.includes("reclaimed") ? "reclaimed" : "absent");
    log.info("a card's bench was cleared", { ...facts, reason, nodes: nodes.length });
    return { cardId: newest.cardId, outcome: "cleared", reason };
  }
  const last = Math.max(lastAttemptMs, read.kind === "card" ? read.updatedAtMs ?? 0 : 0);
  if (reason === "dormant" && deps.now() - last >= ABANDON_AFTER_MS && !kept) {
    await deps.record(card.attempts, reason, "abandoned");
    log.warn("a dormant card's bench could not be cleared for 30 days; it is left to SuperBench's idle sweep", { ...facts, outcomes });
    return { cardId: newest.cardId, outcome: "abandoned", reason };
  }
  return { cardId: newest.cardId, outcome: "retry", reason };
}

/** One sweep: oldest card first, at most `CARDS_PER_SWEEP` board reads. Never throws. */
export async function sweepBenchClearing<T>(deps: ClearingDeps<T>, limit = CARDS_PER_SWEEP): Promise<CardClearing[]> {
  const results: CardClearing[] = [];
  let cards: BenchedCard<T>[];
  try { cards = await deps.cards(); } catch (error) {
    log.warn("benched cards could not be read; the next sweep tries again", { error: error instanceof Error ? error.message : String(error) });
    return results;
  }
  let reads = 0;
  for (const card of cards.toSorted((a, b) => latest(a.attempts).updatedAtMs - latest(b.attempts).updatedAtMs)) {
    if (reads >= limit) break;
    try {
      const result = await clearCardBench(card, deps);
      if (result.outcome !== "unsettled" && result.outcome !== "kept") reads++;
      results.push(result);
    } catch (error) {
      reads++;
      log.warn("a card's bench could not be judged; the next sweep tries again",
        { cardId: card.attempts[0]?.cardId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

// ── the real effects ────────────────────────────────────────────────────────

async function benchedCards(): Promise<BenchedCard[]> {
  const rows = await db.select({ row: checkpointDispatches }).from(checkpointDispatches)
    .leftJoin(benchClearances, and(eq(benchClearances.tenantId, checkpointDispatches.tenantId), eq(benchClearances.attemptId, checkpointDispatches.attemptId)))
    .where(isNull(benchClearances.attemptId));
  const cards = new Map<string, BenchedCard>();
  for (const { row } of rows) {
    let source: RetainedCheckpointAttempt;
    try { source = checkedCheckpointAttempt(row); } catch (error) {
      log.warn("a checkpoint attempt does not pass its checks; its bench is not judged", { tenantId: row.tenantId, attemptId: row.attemptId,
        error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const identity = source.request.identity;
    const attempt: CardAttempt = { tenantId: row.tenantId, boardId: row.boardId, cardId: identity.card_id, stationId: identity.station_id,
      nodeId: source.profile.target.node_id, runId: row.runId, attemptId: row.attemptId, phase: row.phase,
      createdAtMs: row.createdAt.getTime(), updatedAtMs: row.updatedAt.getTime(), source };
    const key = `${row.tenantId}\u0000${row.boardId}\u0000${identity.card_id}`;
    const card = cards.get(key) ?? { attempts: [] };
    card.attempts.push(attempt);
    cards.set(key, card);
  }
  return [...cards.values()];
}

async function readCard(attempt: CardAttempt): Promise<CardRead> {
  try {
    const client = await checkpointAgentClient(attempt.source.profile);
    return cardReadFromView(await client.runRecord(attempt.runId), attempt.runId, attempt.cardId);
  } catch (error) {
    const read = cardReadFromError(error);
    if (read.kind === "unknown") log.info("a benched card could not be read; only its attempts' age counts", { tenantId: attempt.tenantId,
      boardId: attempt.boardId, cardId: attempt.cardId, error: error instanceof Error ? error.message : String(error) });
    return read;
  }
}

async function record(attempts: CardAttempt[], reason: ClearingReason, outcome: "reclaimed" | "absent" | "abandoned"): Promise<void> {
  if (attempts.length === 0) return;
  await db.insert(benchClearances).values(attempts.map((a) => ({ tenantId: a.tenantId, attemptId: a.attemptId, cardId: a.cardId, reason, outcome })))
    .onConflictDoNothing();
}

export function clearingDeps(): ClearingDeps {
  return { cards: benchedCards, readCard, keepBench: (a) => stageKeepsBench(a.source.profile),
    reclaim: (target, reason) => reclaimCardBench(target, reason), record, now: Date.now, dormantMs: dormantAfterMs() };
}

/** Start the sweep: the first one an interval after start, so nodes have reconnected. */
export function startBenchClearing(intervalMs = CLEARING_INTERVAL_MS): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepBenchClearing(clearingDeps()).finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
