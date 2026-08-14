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
 *
 * A fourth was measured on the live hub, on the bridge's very first cycle: it
 * claimed a card two seconds after a restart, before the node-agents had
 * reconnected, and the session open threw "Node is offline.". The card sat in
 * `working` with a delegate assigned, held by a run that would never do
 * anything, until the board's 15-minute reclaim. Two rules came out of it:
 *
 * 4. **Nothing is claimed until the station can run it**, so the window is not
 *    entered in the first place; and **a claim that never started is handed
 *    back**, so the window that remains costs seconds instead of 15 minutes.
 *    "Never started" is exact: no ACP session was opened, so nothing can have
 *    touched the workspace and `release` is unambiguously safe. Once a session
 *    exists the answer changes — see `failStarted`.
 *
 * A fifth came from running a real card and then being unable to say what had
 * happened. The hub could count what arrived — 142 rows in `acp_events`, 135 of
 * them `agent-update` — and had no way at all to count what it posted out.
 *
 * 5. **A dispatch counts both ends of its own transcript.** Coalescing is the
 *    reason 1,051 Hermes events do not become 1,051 HTTP POSTs, and until this
 *    it could have been completely broken in production with nothing to show
 *    it. Two integers on the ledger row and one log line per worked card — see
 *    `summarise`, which is also where the bound on that lives.
 */

import { CARD_PROMPT_VERSION, CardPrompt, renderCardPrompt, type AcpEvent, type AcpSessionMode } from "@agentpod/contract";

import { ActivityCoalescer, type BoardActivity } from "./coalesce";
import type { BridgeAgentConfig } from "./config";
import { isForeignRun, isLeaseSuperseded, KaambaanClient, type ClaimedWork } from "./kaambaan";
import {
  endAttempt,
  findUnreportedOutput,
  markAbandoned,
  markReleased,
  markReported,
  openDispatch,
  recordCoalescing,
  recordProduced,
  startAttempt,
  type CoalescingCounts,
  type DispatchKey,
} from "./ledger";

/**
 * The slice of the hub's ACP session machinery a dispatch needs.
 *
 * An interface rather than a direct import so a test can script a turn without
 * a station — the same seam `acp-agent.ts` already uses for Doors.
 */
export interface AcpPort {
  /**
   * Could a session be opened on this station right now? Asked BEFORE a claim,
   * because a claim the bridge cannot execute strands a card on the board.
   */
  stationReady(input: { stationId: string; userId: string }): Promise<{ ready: boolean; reason?: string }>;
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
  /** The station cannot run work, so NOTHING was claimed. No card was touched. */
  | "not-ready"
  /** Claimed, never started, handed straight back. The card is claimable again. */
  | "released"
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

  // ─── requirement 4a: do not claim work there is nowhere to run ─────────────
  // The board hands out a card on a claim; the hub cannot un-hand it for 15
  // minutes except by asking. Checking first is what removes the race entirely,
  // including the restart case that produced it — the bridge starts with the
  // hub, the node-agents dial back in seconds later.
  const readiness = await acp.stationReady({ stationId: agent.stationId, userId: agent.hubUserId });
  if (!readiness.ready) {
    const reason = readiness.reason ?? "the station cannot run work right now";
    log("not claiming: the station is not ready", { station: agent.stationId, reason });
    return { status: "not-ready", reason };
  }

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

  // ─── claimed, and nothing has run yet ──────────────────────────────────────
  // Everything from here to the session opening happens on a card this bridge
  // holds and has not begun. A throw anywhere in it used to escape to the loop,
  // which logged and backed off — leaving the card `working` with a delegate
  // assigned and a run that would never do anything. It is handed back instead.
  let text: string;
  let session: { id: string };
  try {
    await openDispatch({ ...key, agentKey: agent.key, stationId: agent.stationId, leaseEpoch: work.leaseEpoch });

    // ─── requirement 3: check for prior output BEFORE starting work ──────────
    const prior = await findUnreportedOutput(key);
    if (prior) return await replay(deps, key, work, prior);

    // ─── the prompt contract ────────────────────────────────────────────────
    text = renderCardPrompt(await assemblePrompt(deps, work));

    // ─── the session ────────────────────────────────────────────────────────
    session = await acp.createSession({ stationId: agent.stationId, userId: agent.hubUserId, mode: agent.mode });
  } catch (err) {
    return await handBack(deps, key, work, err);
  }

  const coalescer = new ActivityCoalescer();
  let attemptId: string | null = null;
  let lastSeq = 0;
  const said: string[] = [];
  /**
   * Requirement 5's two numbers (see the header). Counted here rather than
   * inside the coalescer because the pair only means anything together, and one
   * of them — what left for the board — is this function's business, not the
   * projection's. Both are plain integers held for the length of one dispatch;
   * nothing accumulates per event.
   */
  const counts: CoalescingCounts = { eventsReceived: 0, activitiesPosted: 0 };
  // Hoisted so the failure exit below can tear them down: a throw here must not
  // leave a live subscription and a heartbeat still beating for a run that is
  // over. Both are idempotent, so the happy path's own cleanup still stands.
  let unsubscribe: () => void = () => {};
  let beat: ReturnType<typeof setInterval> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // ─── a session exists from here on ─────────────────────────────────────────
  // Which changes the answer to "what should happen if this fails": the harness
  // may already have edited the workspace, so the claim is NOT handed back. See
  // `failStarted`.
  try {
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
        // Counted where the activity is sent, not where the board acknowledges
        // it: this number answers "how much did the transcript collapse to",
        // and a 502 on the wire is a delivery question. The queue logs those
        // separately, and coalescing is what bounds how many there can be.
        counts.activitiesPosted++;
        queue(async () => {
          await client.activity(work, a);
        });
      }
    };

    unsubscribe = acp.subscribe(session.id, (event) => {
      lastSeq = Math.max(lastSeq, event.seq);
      // Every event, before any branch drops one — this is the number an
      // operator can cross-check against `SELECT count(*) FROM acp_events`.
      counts.eventsReceived++;

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

    beat = setInterval(() => {
      queue(async () => {
        await client.heartbeat(work);
      });
    }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

    const timeout = new Promise<TurnEnd>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    });

    let end: TurnEnd;
    try {
      await acp.promptSession(agent.hubUserId, session.id, text);
      end = await Promise.race([turn, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (beat) clearInterval(beat);
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
      await afterTheBoardWasTold(deps, "the card was blocked", () => markAbandoned(key, reason));
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

    await afterTheBoardWasTold(deps, "the card was completed", () => markReported(key));
    return { status: "reported", externalRunId: work.runId, attemptId: attemptId ?? undefined };
  } catch (err) {
    return await failStarted(deps, key, work, attemptId, lastSeq, session.id, err);
  } finally {
    if (timer) clearTimeout(timer);
    if (beat) clearInterval(beat);
    unsubscribe();
    // In the `finally`, so the summary is written once for every exit a session
    // had — including the one that threw. Reachable only from here, which is
    // also why a claim that never opened a session leaves both columns null
    // rather than claiming it counted zero of everything.
    await summarise(deps, key, work, attemptId, counts, coalescer.unmapped());
  }
}

/**
 * The whole observability surface for one dispatch: two integers on its ledger
 * row, and one line in the hub log.
 *
 * **One line, at the end.** Not one per event — that is precisely the volume
 * coalescing exists to prevent, and issue #231 is a live example of a per-cycle
 * log line making `apn logs` unusable at 83% of total volume. Not one per claim
 * cycle either: the bridge polls every five seconds forever, and a cycle that
 * claimed nothing has nothing to say. One line per card actually worked, which
 * is minutes of harness time apiece.
 *
 * **Counts and ids, no payloads.** The bridge deliberately never logs its
 * token; card content, prompts and harness output are treated the same. What
 * appears here is arithmetic and identifiers that are already in the ledger.
 * `unmapped` is the exception that proves it — event *kind* names, a closed set
 * of ACP vocabulary, and the reason a surprising zero is legible instead of
 * merely alarming.
 *
 * A failure to record this must never change the run's outcome: the work is
 * real and the count is a note about it.
 */
async function summarise(
  deps: DispatchDeps,
  key: DispatchKey,
  work: ClaimedWork,
  attemptId: string | null,
  counts: CoalescingCounts,
  unmapped: string[],
): Promise<void> {
  const log = deps.log ?? (() => {});
  try {
    await recordCoalescing(key, counts);
  } catch (err) {
    log("the coalescing summary could not be recorded", { run: work.runId, error: String(err) });
  }

  log("coalesced the transcript", {
    run: work.runId,
    card: key.externalCardId,
    station: deps.agent.stationId,
    attempt: attemptId,
    events: counts.eventsReceived,
    activities: counts.activitiesPosted,
    // The number the 18x spread made necessary: how many events collapsed into
    // each activity. Null when nothing was posted — a ratio over zero is not a
    // large number, it is an absent one, and rounding it to Infinity in a log
    // reads as a bug rather than as the finding it is.
    eventsPerActivity: eventsPerActivity(counts),
    ...(unmapped.length ? { unmapped } : {}),
  });
}

/** Events per activity, to one decimal place. Null when nothing was posted. */
function eventsPerActivity(counts: CoalescingCounts): number | null {
  if (counts.activitiesPosted === 0) return null;
  return Math.round((counts.eventsReceived / counts.activitiesPosted) * 10) / 10;
}

/**
 * Report a prior run's recorded output onto the run holding the card now.
 *
 * The harness is not started: the work is not idempotent, but the report is.
 * A refusal here is handled by the caller's hand-back — nothing ran on THIS
 * run, and the prior row keeps its `produced` outcome, so the next claim of the
 * card finds it again.
 */
async function replay(
  deps: DispatchDeps,
  key: DispatchKey,
  work: ClaimedWork,
  prior: { externalRunId: string; result: unknown },
): Promise<DispatchResult> {
  (deps.log ?? (() => {}))("replaying a prior run's output", {
    card: key.externalCardId,
    priorRun: prior.externalRunId,
  });
  await deps.client.complete(work, prior.result ?? undefined);
  await afterTheBoardWasTold(deps, "the replay was reported", async () => {
    await markReported(key);
    await markReported({ ...key, externalRunId: prior.externalRunId });
  });
  return { status: "replayed", externalRunId: work.runId };
}

/**
 * A ledger write that happens AFTER the board has been told, and must not throw
 * into the failure exits.
 *
 * Those exits send a verb — `release` before a session, `fail` after one — and
 * a verb sent on top of a `complete` is a write to a run the board has already
 * ended. The card's state is the board's; this row is our note about it, and a
 * lost note is not a reason to contradict the board.
 */
async function afterTheBoardWasTold(
  deps: DispatchDeps,
  what: string,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    (deps.log ?? (() => {}))("the board was told, but the ledger could not be updated", {
      what,
      error: String(err),
    });
  }
}

/**
 * Give the claim back: this run never started.
 *
 * Safe precisely because no session was opened — no harness process exists, no
 * command ran, no file changed — so the card returns to the queue exactly as it
 * left it. kaambaan's `release` is the unpenalised verb for that (board-do.ts:
 * card back to `submitted`, delegate cleared, no failure count), and the card is
 * claimable in seconds instead of after the 15-minute heartbeat reclaim.
 *
 * A run whose lease is already gone is NOT released: a 409/409-class refusal
 * means the board has moved on, and `release` would be one more write to a card
 * that is now someone else's.
 */
async function handBack(
  deps: DispatchDeps,
  key: DispatchKey,
  work: ClaimedWork,
  cause: unknown,
): Promise<DispatchResult> {
  const log = deps.log ?? (() => {});
  if (isLeaseSuperseded(cause) || isForeignRun(cause)) {
    return await abort(deps, key, work, null, cause);
  }

  const reason = `no session was opened, so the claim was handed back: ${String(cause)}`;
  try {
    await deps.client.release(work);
  } catch (err) {
    // The board keeps the card until its own reclaim — the outcome this fix
    // exists to avoid, reached only when the board itself cannot be reached.
    log("the claim could not be handed back", { run: work.runId, error: String(err) });
    await markAbandoned(key, `${reason} — but the release was refused: ${String(err)}`).catch(() => {});
    return { status: "failed", externalRunId: work.runId, reason };
  }

  log("claimed with nothing to run it; the card was handed back", { run: work.runId, error: String(cause) });
  await markReleased(key, reason).catch(() => {});
  return { status: "released", externalRunId: work.runId, reason };
}

/**
 * A session had already opened, and then something failed.
 *
 * **Not released.** The harness may have edited the workspace before the wire
 * dropped, and kaambaan's reclaim is at-least-once: a `release` puts the card
 * straight back in the queue, unpenalised, for a claimer with no way to learn
 * that part of the work was already done. `fail` re-queues it too — but carries
 * the reason and increments the card's failure count, so a station that keeps
 * dying trips kaambaan's circuit breaker into `input-required` for a human
 * (board-do.ts `endAttempt`) rather than looping forever. `block` would put a
 * transient node blip in front of a human every time; letting the lease lapse
 * costs 15 minutes and tells the board nothing at all.
 *
 * The ACP session is ended first, for the same reason a superseded lease ends
 * it: kaambaan fences its own state, and nothing else fences the machine.
 */
async function failStarted(
  deps: DispatchDeps,
  key: DispatchKey,
  work: ClaimedWork,
  attemptId: string | null,
  lastSeq: number,
  sessionId: string,
  cause: unknown,
): Promise<DispatchResult> {
  const log = deps.log ?? (() => {});
  if (isLeaseSuperseded(cause) || isForeignRun(cause)) {
    return await abort(deps, key, work, attemptId, cause, sessionId);
  }

  const reason =
    `a session had started and then failed, so the workspace may hold partial work: ${String(cause)}`;
  log("the run failed after its session had started", { run: work.runId, error: String(cause) });

  await deps.acp.endSession(deps.agent.hubUserId, sessionId, reason).catch(() => {});
  await deps.client.fail(work, reason).catch((err) => {
    log("the board could not be told the run failed", { run: work.runId, error: String(err) });
  });
  if (attemptId) await endAttempt(attemptId, "failed", lastSeq || null);
  await markAbandoned(key, reason);

  return { status: "failed", externalRunId: work.runId, attemptId: attemptId ?? undefined, reason };
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
