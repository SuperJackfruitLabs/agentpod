/**
 * How a dispatch ends when it does not end in an ordinary report: the coalescing summary, a
 * replay, a hand-back, a failure after the session started, and a lost lease. Split out of
 * dispatch.ts, unchanged.
 */

import { isControlPairDenied } from "../control";
import type { DispatchDeps, DispatchResult } from "./dispatch-types";
import { endAttempt, markAbandoned, markReleased, markReported, recordCoalescing, type CoalescingCounts, type DispatchKey } from "./ledger";
import { isForeignRun, isLeaseSuperseded, type ClaimedWork } from "./superpipeline";

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
export async function summarise(
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
export async function replay(
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
export async function afterTheBoardWasTold(
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
 * left it. superpipeline's `release` is the unpenalised verb for that (board-do.ts:
 * card back to `submitted`, delegate cleared, no failure count), and the card is
 * claimable in seconds instead of after the 15-minute heartbeat reclaim.
 *
 * A run whose lease is already gone is NOT released: a 409/409-class refusal
 * means the board has moved on, and `release` would be one more write to a card
 * that is now someone else's.
 */
export async function handBack(
  deps: DispatchDeps,
  key: DispatchKey,
  work: ClaimedWork,
  cause: unknown,
): Promise<DispatchResult> {
  const log = deps.log ?? (() => {});
  if (isLeaseSuperseded(cause) || isForeignRun(cause)) {
    return await abort(deps, key, work, null, cause);
  }

  // A refusal by the control pair is PERMANENT, and handing the claim back
  // would be a hot loop: the board reissues the card, the same agent claims it,
  // the same principal is refused, forever — bounded only by a circuit breaker
  // that a release may never trip.
  //
  // So it fails the card instead, and says why as structured work activity
  // rather than as a stringified exception. charter
  // decisions/2026-08-13-ecosystem-identity.md requires exactly that: "a denial
  // must be reported back as structured work activity, never silently dropped."
  // An operator reading the board should see that permission was missing, not
  // that something went wrong.
  if (isControlPairDenied(cause)) {
    const reason = `dispatch refused: ${cause.principalId} may not dispatch ${cause.stationKey}`;
    try {
      await deps.client.activity(work, {
        type: "error",
        body: "This agent was not dispatched: the operator who queued it does not have permission to dispatch this station.",
        action: "control-pair.denied",
        parameter: { principalId: cause.principalId, stationKey: cause.stationKey },
      });
    } catch (err) {
      // The board may be unreachable; the fail below still carries the reason.
      log("the denial could not be posted as activity", { run: work.runId, error: String(err) });
    }
    try {
      await deps.client.fail(work, reason);
    } catch (err) {
      log("the denial could not be failed onto the board", { run: work.runId, error: String(err) });
      await markAbandoned(key, `${reason} — and the fail was refused: ${String(err)}`).catch(() => {});
      return { status: "failed", externalRunId: work.runId, reason };
    }
    log("dispatch refused by the control pair", {
      run: work.runId,
      principalId: cause.principalId,
      stationKey: cause.stationKey,
    });
    await markAbandoned(key, reason).catch(() => {});
    return { status: "failed", externalRunId: work.runId, reason };
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
 * dropped, and superpipeline's reclaim is at-least-once: a `release` puts the card
 * straight back in the queue, unpenalised, for a claimer with no way to learn
 * that part of the work was already done. `fail` re-queues it too — but carries
 * the reason and increments the card's failure count, so a station that keeps
 * dying trips superpipeline's circuit breaker into `input-required` for a human
 * (board-do.ts `endAttempt`) rather than looping forever. `block` would put a
 * transient node blip in front of a human every time; letting the lease lapse
 * costs 15 minutes and tells the board nothing at all.
 *
 * The ACP session is ended first, for the same reason a superseded lease ends
 * it: superpipeline fences its own state, and nothing else fences the machine.
 */
export async function failStarted(
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
 * Outcomes an agent can write to its own run. Everything else on `runs.outcome`
 * — `released`, `reclaimed` — is the board taking the card BACK, which is the
 * opposite fact and must not be read as a report.
 */
const AGENT_AUTHORED_OUTCOMES = new Set(["completed", "submitted", "blocked"]);

/**
 * Did the agent end this run itself?
 *
 * An agentpod-driven agent now carries a run-scoped superpipeline token and calls
 * `superpipeline_complete` (or `_block`) through MCP. When it does, the run is
 * already `ended` by the time the bridge sends its own `complete`, and the board
 * answers the same 409 `STALE_LEASE` it sends for a lease reclaimed out from
 * under us. One code, two opposite facts: the card finished by the agent we
 * dispatched, or the card taken away from it.
 *
 * The run row is what tells them apart, so it is re-read. `GET /runs/:runId`
 * needs no lease — that is exactly why it can still be read here — but it does
 * check ownership, so a foreign run answers 403 rather than lying.
 *
 * **A read that fails means no.** Returning "the agent reported" on the strength
 * of a read that never happened would mark the ledger `reported` for work
 * nothing vouched for; the superseded-lease path costs a re-queue and vouches
 * for nothing it did not see.
 */
async function endedByTheAgent(deps: DispatchDeps, work: ClaimedWork): Promise<string | null> {
  try {
    const { run } = await deps.client.context(work.runId);
    if (!run || run.status !== "ended") return null;
    return run.outcome && AGENT_AUTHORED_OUTCOMES.has(run.outcome) ? run.outcome : null;
  } catch (err) {
    (deps.log ?? (() => {}))("the run could not be re-read after a stale lease", {
      run: work.runId,
      error: String(err),
    });
    return null;
  }
}

/**
 * Stop, without touching the run again.
 *
 * Deliberately no `fail` and no `release`: both would 409 on a superseded lease
 * and both are an attempt to write to a card that is now someone else's. A
 * "tidy" cleanup call here is the retry loop this distinction exists to prevent.
 */
export async function abort(
  deps: DispatchDeps,
  key: DispatchKey,
  work: ClaimedWork,
  attemptId: string | null,
  cause: unknown,
  sessionId?: string,
): Promise<DispatchResult> {
  const log = deps.log ?? (() => {});
  const foreign = cause === "foreign-run" || isForeignRun(cause);
  const stale = cause === "lease-superseded" || isLeaseSuperseded(cause);

  if (!foreign && !stale) {
    // Some other refusal on the replay path. Leave the ledger alone so the
    // output stays replayable.
    return { status: "failed", externalRunId: work.runId, reason: String(cause) };
  }

  /**
   * Before calling a lost lease a lost lease: did the agent end this run itself?
   *
   * **The check lives here rather than at the `complete` call site, and a live run is why.** An
   * agent that reports through MCP completes the run mid-turn; the harness then says one more
   * thing, the bridge posts that as an activity, and THAT is the call that gets the 409 —
   * seconds before the bridge would have sent its own `complete`. Checking only where the
   * bridge reports meant the first real self-report was recorded `abandoned`, "the lease was
   * superseded", on a card the agent had finished correctly and left a reference on.
   *
   * `abort` is the single funnel every stale-lease path reaches — the activity chain, the turn
   * end, `failStarted`, the report itself — so one check here covers all of them.
   *
   * Never for a foreign run: that is another agent's outcome, and reading it as our own report
   * is exactly the confusion `denyForeignRun` exists to prevent.
   */
  if (stale && !foreign) {
    const authored = await endedByTheAgent(deps, work);
    if (authored) {
      const said = `the agent ended its own run: ${authored}`;
      log("the agent reported for itself; the bridge's report was redundant", {
        run: work.runId,
        card: key.externalCardId,
        outcome: authored,
      });
      if (sessionId) {
        await deps.acp.endSession(deps.agent.hubUserId, sessionId, `The card was ${authored} by the agent.`).catch(() => {});
      }
      if (attemptId) await endAttempt(attemptId, "completed", null);
      await afterTheBoardWasTold(deps, "the agent had already reported", () => markReported(key));
      return { status: "self-reported", externalRunId: work.runId, attemptId: attemptId ?? undefined, reason: said };
    }
  }

  const reason = foreign
    ? "this run belongs to another agent — the bridge must not drive it"
    : "the lease was superseded: it lapsed or was reassigned, and the card has been re-queued";

  if (sessionId) {
    // The concrete deliverable of the spike. superpipeline fenced its data; this is
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
