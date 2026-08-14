/**
 * One claim, worked start to finish.
 *
 *   claim → check for prior output → read the run's context → assemble the
 *   prompt → open an ACP session → coalesce the transcript into activities →
 *   report → close.
 *
 * Three things here exist because the spike measured them and could not fix
 * them in throwaway code:
 *
 * 1. **A 409 ends the ACP session.** kaambaan fences its own state — the
 *    reclaim experiment came back with `leaseEpoch: 2` and the old run locked
 *    out of every write. But nothing fences the *machine*: the original harness
 *    kept executing with no idea its lease had been revoked, and in a task that
 *    outlives the 15-minute reclaim two harnesses would be writing the same
 *    directory while kaambaan correctly ignored one of them. The lease is
 *    learned to be stale on a verb; that is where the session is ended.
 *
 * 2. **A 403 is not a 409.** `NOT_RUN_OWNER` means this run belongs to another
 *    agent — understood, permanently refused, and a bug in the caller.
 *    Retrying repeats the hijack, so this run is never touched again and the
 *    agent's loop stops rather than claiming into the same fault.
 *
 * 3. **The prior-output check comes before the work.** Reclaim is at-least-once:
 *    a run that finished and never reported comes back. The work is not
 *    idempotent — it edited a workspace — but the *report* is, so a recorded
 *    handoff is replayed onto the new run and the harness is not started.
 */

import { CARD_PROMPT_VERSION, CardPrompt, renderCardPrompt, type AcpEvent, type AcpSessionMode } from "@agentpod/contract";

import { ActivityCoalescer, type BoardActivity } from "./coalesce";
import type { BridgeAgentConfig } from "./config";
import { isForeignRun, isLeaseSuperseded, KaambaanClient, type ClaimedWork } from "./kaambaan";
import {
  endAttempt,
  findUnreportedOutput,
  markAbandoned,
  markReported,
  openDispatch,
  recordProduced,
  startAttempt,
  type DispatchKey,
} from "./ledger";

/**
 * The slice of the hub's ACP session machinery a dispatch needs.
 *
 * An interface rather than a direct import so a test can script a turn without
 * a station — the same seam `acp-agent.ts` already uses for Doors.
 */
export interface AcpPort {
  createSession(input: { stationId: string; userId: string; mode: AcpSessionMode }): Promise<{ id: string }>;
  promptSession(userId: string, sessionId: string, text: string): Promise<void>;
  subscribe(sessionId: string, fn: (e: AcpEvent) => void): () => void;
  endSession(userId: string, sessionId: string, reason: string): Promise<void>;
}

export interface DispatchDeps {
  client: KaambaanClient;
  acp: AcpPort;
  agent: BridgeAgentConfig;
  tenantId: string;
  source: string;
  heartbeatMs?: number;
  turnTimeoutMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export type DispatchStatus =
  /** Nothing to claim (or the board is over budget, or we are at capacity). */
  | "idle"
  /** A prior run's output was reported; the harness was not started. */
  | "replayed"
  /** Worked and reported. */
  | "reported"
  /** Worked; the board could not be told. Recoverable — the output is recorded. */
  | "unreported"
  /** The lease lapsed mid-run. The harness was stopped. */
  | "lease-superseded"
  /** The run belongs to another agent. A bug: the loop must not continue. */
  | "foreign-run"
  /** Parked for a human — a permission request with no return path. */
  | "blocked"
  /** The harness or the session failed. */
  | "failed";

export interface DispatchResult {
  status: DispatchStatus;
  externalRunId?: string;
  attemptId?: string;
  reason?: string;
}

/** kaambaan reclaims at 15 minutes; RQ3 measured 12.3s as the longest silence. */
const DEFAULT_HEARTBEAT_MS = 60_000;
/** A harness that never yields still has to end somewhere. */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
/** How much of what the agent said rides in the handoff. */
const SUMMARY_LIMIT = 4_000;

/** Why a turn stopped, as far as the event stream is concerned. */
type TurnEnd =
  | { kind: "yielded" }
  | { kind: "session-ended"; reason: string }
  | { kind: "lease-superseded" }
  | { kind: "foreign-run" }
  | { kind: "permission-required" }
  | { kind: "timeout" };

export async function runOnce(deps: DispatchDeps): Promise<DispatchResult> {
  const { client, acp, agent, tenantId, source } = deps;
  const log = deps.log ?? (() => {});

  const work = await client.claim({ maxConcurrency: agent.maxConcurrency, profileKey: agent.profileKey });
  // A bare "not claimed" covers an empty queue, an over-budget board and an
  // agent at its concurrency cap alike. kaambaan does not say which.
  if (!work) return { status: "idle" };

  const key: DispatchKey = {
    tenantId,
    externalSource: source,
    boardId: agent.boardId,
    externalCardId: work.card.id,
    externalRunId: work.runId,
  };

  await openDispatch({ ...key, agentKey: agent.key, stationId: agent.stationId, leaseEpoch: work.leaseEpoch });

  // ─── requirement 3: check for prior output BEFORE starting work ────────────
  const prior = await findUnreportedOutput(key);
  if (prior) {
    log("replaying a prior run's output", { card: work.card.id, priorRun: prior.externalRunId });
    try {
      await client.complete(work, prior.result ?? undefined);
    } catch (err) {
      return await abort(deps, key, work, null, err);
    }
    await markReported(key);
    await markReported({ ...key, externalRunId: prior.externalRunId });
    return { status: "replayed", externalRunId: work.runId };
  }

  // ─── the prompt contract ───────────────────────────────────────────────────
  let text: string;
  try {
    text = renderCardPrompt(await assemblePrompt(deps, work));
  } catch (err) {
    await client.release(work).catch(() => {});
    await markAbandoned(key, `could not assemble the prompt: ${String(err)}`);
    return { status: "failed", externalRunId: work.runId, reason: String(err) };
  }

  // ─── the session ───────────────────────────────────────────────────────────
  const session = await acp.createSession({ stationId: agent.stationId, userId: agent.hubUserId, mode: agent.mode });

  const coalescer = new ActivityCoalescer();
  let attemptId: string | null = null;
  let lastSeq = 0;
  const said: string[] = [];

  let settle: (end: TurnEnd) => void = () => {};
  const turn = new Promise<TurnEnd>((resolve) => {
    let done = false;
    settle = (end) => {
      if (done) return;
      done = true;
      resolve(end);
    };
  });

  /**
   * A lost lease learned late still ends the run.
   *
   * Posts are queued, so a 409 can surface *after* the harness has already
   * yielded and the turn has settled as "yielded". Latching it here rather than
   * relying on the race means the outcome does not depend on whether the board
   * answered before or after the last event arrived — and the alternative is a
   * `complete` sent on a card somebody else now holds.
   */
  let abortCause: "lease-superseded" | "foreign-run" | null = null;

  // Posts are serialized so activities reach the board in transcript order —
  // the same reason acp-sessions chains its own writes.
  let chain: Promise<void> = Promise.resolve();
  const queue = (fn: () => Promise<void>): void => {
    chain = chain.then(fn).catch((err) => {
      if (isLeaseSuperseded(err)) {
        abortCause ??= "lease-superseded";
        return settle({ kind: "lease-superseded" });
      }
      if (isForeignRun(err)) {
        abortCause ??= "foreign-run";
        return settle({ kind: "foreign-run" });
      }
      // Anything else is transient: a dropped activity is not worth ending a
      // run over, and the board's own ordering is by its `seq`, not ours.
      log("activity post failed", { error: String(err) });
    });
  };

  const post = (activities: BoardActivity[]): void => {
    for (const a of activities) {
      if (a.type === "response" && a.body) said.push(a.body);
      queue(async () => {
        await client.activity(work, a);
      });
    }
  };

  const unsubscribe = acp.subscribe(session.id, (event) => {
    lastSeq = Math.max(lastSeq, event.seq);

    if (attemptId === null && !attemptStarted) {
      attemptStarted = true;
      // The run join, written as soon as the attempt has a first seq.
      queue(async () => {
        attemptId = await startAttempt({
          ...key,
          sessionId: session.id,
          stationId: agent.stationId,
          startSeq: event.seq,
        });
      });
    }

    if (event.type === "permission-request") {
      post(coalescer.push(event));
      return settle({ kind: "permission-required" });
    }

    if (event.type === "state") {
      const status = (event.payload as { status?: string } | null)?.status;
      if (status === "idle") return settle({ kind: "yielded" });
      if (status === "ended") {
        const reason = String((event.payload as { reason?: string } | null)?.reason ?? "session ended");
        return settle({ kind: "session-ended", reason });
      }
      return;
    }

    post(coalescer.push(event));
  });
  let attemptStarted = false;

  const beat = setInterval(() => {
    queue(async () => {
      await client.heartbeat(work);
    });
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<TurnEnd>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
  });

  let end: TurnEnd;
  try {
    await acp.promptSession(agent.hubUserId, session.id, text);
    end = await Promise.race([turn, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    clearInterval(beat);
  }

  await chain;
  post(coalescer.flush());
  await chain;
  unsubscribe();

  // ─── requirement 2: the lease is gone, so the harness must stop ────────────
  // `abortCause` is checked before `end`, because a queued post can answer 409
  // after the harness has yielded — and a yield is not permission to report.
  const aborted = abortCause ?? (end.kind === "lease-superseded" || end.kind === "foreign-run" ? end.kind : null);
  if (aborted) {
    return await abort(deps, key, work, attemptId, aborted, session.id);
  }

  if (end.kind === "permission-required") {
    // RQ2: an elicitation is a dead end — kaambaan's input-required → working
    // transition exists and nothing invokes it. Park the card for a human
    // rather than hold the harness until the reclaim.
    await acp.endSession(agent.hubUserId, session.id, "A permission request has no return path through the board.").catch(() => {});
    if (attemptId) await endAttempt(attemptId, "input-required", lastSeq);
    const reason = "the agent asked for permission, which the board cannot answer";
    await client.block(work, reason).catch(() => {});
    await markAbandoned(key, reason);
    return { status: "blocked", externalRunId: work.runId, attemptId: attemptId ?? undefined, reason };
  }

  const contextPeak = coalescer.contextPeak();
  const handoff = {
    summary: said.join("").slice(0, SUMMARY_LIMIT) || null,
    station: agent.stationId,
    session: session.id,
    attempt: attemptId,
    // Context occupancy, not cost: no harness reports tokens or money over ACP.
    ...(contextPeak ? { contextPeak } : {}),
  };

  // Written BEFORE the board is told. A bridge that dies between these two
  // leaves a recoverable fact instead of a card that will be worked twice.
  await recordProduced(key, handoff);
  if (attemptId) await endAttempt(attemptId, end.kind === "yielded" ? "completed" : "failed", lastSeq);
  await acp.endSession(agent.hubUserId, session.id, "The board's card is complete.").catch(() => {});

  if (end.kind === "timeout" || end.kind === "session-ended") {
    const reason = end.kind === "timeout" ? "the turn exceeded its time limit" : end.reason;
    try {
      await client.fail(work, reason);
      await markAbandoned(key, reason);
      return { status: "failed", externalRunId: work.runId, attemptId: attemptId ?? undefined, reason };
    } catch (err) {
      return await abort(deps, key, work, attemptId, err);
    }
  }

  try {
    await client.complete(work, handoff);
  } catch (err) {
    if (isLeaseSuperseded(err) || isForeignRun(err)) {
      return await abort(deps, key, work, attemptId, err);
    }
    // The work is done and recorded; the board just did not hear. The next
    // claim of this card replays it — which is the whole point of writing the
    // output down first.
    log("the board could not be told; the output is recorded for replay", { run: work.runId, error: String(err) });
    return { status: "unreported", externalRunId: work.runId, attemptId: attemptId ?? undefined, reason: String(err) };
  }

  await markReported(key);
  return { status: "reported", externalRunId: work.runId, attemptId: attemptId ?? undefined };
}

/**
 * Stop, without touching the run again.
 *
 * Deliberately no `fail` and no `release`: both would 409 on a superseded lease
 * and both are an attempt to write to a card that is now someone else's. A
 * "tidy" cleanup call here is the retry loop this distinction exists to prevent.
 */
async function abort(
  deps: DispatchDeps,
  key: DispatchKey,
  work: ClaimedWork,
  attemptId: string | null,
  cause: unknown,
  sessionId?: string,
): Promise<DispatchResult> {
  const foreign = cause === "foreign-run" || isForeignRun(cause);
  const stale = cause === "lease-superseded" || isLeaseSuperseded(cause);

  if (!foreign && !stale) {
    // Some other refusal on the replay path. Leave the ledger alone so the
    // output stays replayable.
    return { status: "failed", externalRunId: work.runId, reason: String(cause) };
  }

  const reason = foreign
    ? "this run belongs to another agent — the bridge must not drive it"
    : "the lease was superseded: it lapsed or was reassigned, and the card has been re-queued";

  if (sessionId) {
    // The concrete deliverable of the spike. kaambaan fenced its data; this is
    // what fences the machine.
    await deps.acp
      .endSession(deps.agent.hubUserId, sessionId, reason)
      .catch(() => {});
  }
  if (attemptId) await endAttempt(attemptId, foreign ? "failed" : "canceled", null);
  await markAbandoned(key, reason);

  return {
    status: foreign ? "foreign-run" : "lease-superseded",
    externalRunId: work.runId,
    attemptId: attemptId ?? undefined,
    reason,
  };
}

/**
 * Assemble the card into the versioned prompt contract.
 *
 * The context read is what makes this possible at all: `GET /runs/:runId`
 * returns the references and the card's `spec`, neither of which the claim
 * carries. The spike had no such endpoint and sent the title.
 */
async function assemblePrompt(deps: DispatchDeps, work: ClaimedWork): Promise<CardPrompt> {
  const ctx = await deps.client.context(work.runId);
  return CardPrompt.parse({
    version: CARD_PROMPT_VERSION,
    source: deps.source,
    boardId: deps.agent.boardId,
    externalRunId: work.runId,
    card: {
      id: ctx.card.id ?? work.card.id,
      title: ctx.card.title ?? work.card.title,
      spec: ctx.card.spec,
    },
    stage: ctx.stage ?? work.stage,
    handoff: ctx.handoff ?? work.handoff,
    references: ctx.references ?? [],
    // attemptCount increments on CLAIM, so the agent working a card is always
    // on attempt 1 or later (RQ4).
    attempt: { number: ctx.card.attemptCount ?? work.card.attemptCount ?? 1 },
  });
}
