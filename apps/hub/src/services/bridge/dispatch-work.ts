/**
 * Everything after a successful claim: opening the session, running the turn, and settling what
 * the turn's end means for the board and the ledger. Split out of dispatch.ts's `workClaimed`,
 * unchanged.
 */

import { renderCardPrompt } from "@agentpod/contract";

import type { AgentSpanRecorder } from "../../telemetry/agent-spans";
import { resolveStationOccupant, within } from "../evidence";
import { isForeignRun, isLeaseSuperseded, type ClaimedWork } from "./superpipeline";
import {
  endAttempt,
  findUnreportedOutput,
  markAbandoned,
  markReported,
  openDispatch,
  recordProduced,
  type DispatchKey,
} from "./ledger";
import { SUMMARY_LIMIT, type DispatchDeps, type DispatchResult, type TurnEnd } from "./dispatch-types";
import { assemblePrompt, boardTools } from "./dispatch-prompt";
import { abort, afterTheBoardWasTold, failStarted, handBack, replay, summarise } from "./dispatch-exits";
import { driveTurn, newTurn, openSegment, post, startHeartbeat, subscribeTurn, type Turn } from "./dispatch-turn";

/**
 * Who the station runs as. The related section needs it before the session opens, but only
 * when related work will actually be fetched (Superlibrary configured, the board switched on):
 * the prompt passes this as a lookup, which `fetchRelatedWork` awaits only then, inside its own
 * deadline. Otherwise nothing is looked up before the session and the attempt does the lookup at
 * its first ACP event, as it always has. An attempt reuses an answer the prompt already got; a
 * null one (no occupant, late, failed) is looked up again at the attempt, as it was before.
 * Each lookup is bounded by `within`, so a late or failed one is null and never holds the turn.
 */
function occupantLookups(deps: DispatchDeps) {
  const resolveOccupant = deps.occupant ?? ((i) => resolveStationOccupant(i.tenantId, i.stationId));
  const lookUpOccupant = () => within(() => resolveOccupant({ tenantId: deps.tenantId, stationId: deps.agent.stationId }), null);
  let promptLookup: Promise<string | null> | null = null;
  const forPrompt = (): Promise<string | null> => (promptLookup ??= lookUpOccupant());
  const forAttempt = async (): Promise<string | null> =>
    (promptLookup ? await promptLookup : null) ?? lookUpOccupant();
  return { forPrompt, forAttempt };
}

type Opened = { result: DispatchResult } | { text: string; session: { id: string; libraryTools?: boolean } };

/**
 * Claimed, and nothing has run yet.
 *
 * Everything from here to the session opening happens on a card this bridge
 * holds and has not begun. A throw anywhere in it used to escape to the loop,
 * which logged and backed off — leaving the card `working` with a delegate
 * assigned and a run that would never do anything. It is handed back instead.
 */
async function openClaimed(
  deps: DispatchDeps,
  work: ClaimedWork,
  key: DispatchKey,
  occupantForPrompt: () => Promise<string | null>,
): Promise<Opened> {
  const { client, acp, agent, tenantId } = deps;
  try {
    await openDispatch({ ...key, agentKey: agent.key, stationId: agent.stationId, leaseEpoch: work.leaseEpoch });

    // ─── requirement 3: check for prior output BEFORE starting work ──────────
    const prior = await findUnreportedOutput(key);
    if (prior) return { result: await replay(deps, key, work, prior) };

    // ─── the prompt contract ────────────────────────────────────────────────
    const prompt = await assemblePrompt(deps, work, occupantForPrompt);

    // ─── the session ────────────────────────────────────────────────────────
    // Always asks for the node's MCP proxy: the node decides (a station its operator named, a
    // harness that takes HTTP MCP servers) and says what it injected.
    const session = await acp.createSession({
      stationId: agent.stationId,
      tenantId,
      userId: agent.hubUserId,
      mode: agent.mode,
      ...(boardTools(deps) ? { mcpServers: boardTools(deps)! } : {}),
      mcpProxy: true,
      executionRun: { source: 'superpipeline', id: work.runId, epoch: work.leaseEpoch },
      validateExecutionRun: () => client.heartbeat(work),
    });
    // Rendered after the session opens, because only the open says which tools it carries (S3-R12).
    const text = renderCardPrompt({ ...prompt, libraryTools: session.libraryTools === true });
    return { text, session };
  } catch (err) {
    return { result: await handBack(deps, key, work, err) };
  }
}

/** Everything after a successful claim. Runs inside the run's `dispatch` span. */
export async function workClaimed(deps: DispatchDeps, work: ClaimedWork, spans: AgentSpanRecorder): Promise<DispatchResult> {
  const { agent, tenantId, source } = deps;

  const key: DispatchKey = {
    tenantId,
    externalSource: source,
    boardId: agent.boardId,
    externalCardId: work.card.id,
    externalRunId: work.runId,
  };

  const occupant = occupantLookups(deps);
  const opened = await openClaimed(deps, work, key, occupant.forPrompt);
  if ("result" in opened) return opened.result;

  const t = newTurn(deps, work, key, opened.session, spans, occupant.forAttempt);

  // ─── a session exists from here on ─────────────────────────────────────────
  // Which changes the answer to "what should happen if this fails": the harness
  // may already have edited the workspace, so the claim is NOT handed back. See
  // `failStarted`.
  try {
    openSegment(t);
    subscribeTurn(t);
    startHeartbeat(t);
    const end = await driveTurn(t, opened.text);

    await t.chain;
    post(t, t.coalescer.flush());
    await t.chain;
    t.unsubscribe();

    return await settleTurn(t, end);
  } catch (err) {
    return await failStarted(deps, key, work, t.attemptId, t.lastSeq, t.session.id, err);
  } finally {
    if (t.timer) clearTimeout(t.timer);
    if (t.beat) clearInterval(t.beat);
    t.unsubscribe();
    // In the `finally`, so the summary is written once for every exit a session
    // had — including the one that threw. Reachable only from here, which is
    // also why a claim that never opened a session leaves both columns null
    // rather than claiming it counted zero of everything.
    //
    // Swallowed whole: a throw in a `finally` REPLACES the value the try block
    // returned, so an unlucky measurement could discard the `foreign-run` that
    // is supposed to halt the loop. A note about the work never outranks it.
    await summarise(deps, key, work, t.attemptId, t.counts, t.coalescer.unmapped()).catch(() => {});
  }
}

/** What the turn's end means: a lost lease, an unanswered question, a failure, or the report. */
async function settleTurn(t: Turn, end: TurnEnd): Promise<DispatchResult> {
  const { deps, key, work } = t;
  // ─── requirement 2: the lease is gone, so the harness must stop ────────────
  // `abortCause` is checked before `end`, because a queued post can answer 409
  // after the harness has yielded — and a yield is not permission to report.
  const aborted = t.abortCause ?? (end.kind === "lease-superseded" || end.kind === "foreign-run" ? end.kind : null);
  if (aborted) {
    return await abort(deps, key, work, t.attemptId, aborted, t.session.id);
  }

  if (end.kind === "unanswered") return await endUnanswered(t, end.reason);

  // Persist the terminal failure BEFORE any remote report. A lost fail response
  // must never leave `produced` output for the next claimant to replay as success.
  // Partial agent prose is evidence of a failed attempt, not a completion receipt.
  if (end.kind === "timeout" || end.kind === "session-ended") {
    const pending = [...t.pendingToolCalls].toSorted();
    const ownWorkTimedOut = end.kind === "timeout" && pending.length > 0;
    const reason = ownWorkTimedOut
      ? `the run exceeded its waiting-on-own-work limit; pending tool calls: ${pending.join(", ")}`
      : end.kind === "timeout"
        ? "the turn exceeded its time limit"
        : end.reason;
    await markAbandoned(key, reason);
    if (t.attemptId) await endAttempt(t.attemptId, "failed", t.lastSeq);
    await deps.acp.endSession(deps.agent.hubUserId, t.session.id, reason).catch(() => {});
    try {
      if (ownWorkTimedOut) {
        await deps.client.block(work, reason);
        return { status: "blocked", externalRunId: work.runId, attemptId: t.attemptId ?? undefined, reason };
      }
      await deps.client.fail(work, reason);
      return { status: "failed", externalRunId: work.runId, attemptId: t.attemptId ?? undefined, reason };
    } catch (err) {
      return await abort(deps, key, work, t.attemptId, err);
    }
  }

  return await reportCompleted(t);
}

/**
 * **Failed, not blocked and not released.** A session started, so the
 * workspace may hold partial work — the same reasoning as `failStarted`.
 * `release` would hand a half-edited workspace to the next claimer with
 * nothing recording it; `block` would park the card AND cancel the
 * question, so the one thing a human could still usefully do disappears.
 * `fail` re-queues the card with the reason and a failure count, so the
 * question is asked again on the next attempt and superpipeline's circuit
 * breaker parks it for a human if nobody ever answers.
 *
 * Ending the session first also resolves the parked ACP request as
 * `cancelled`, which is the honest delivery of "no decision was made".
 */
async function endUnanswered(t: Turn, reason: string): Promise<DispatchResult> {
  const { deps, key, work } = t;
  await deps.acp.endSession(deps.agent.hubUserId, t.session.id, reason).catch(() => {});
  if (t.attemptId) await endAttempt(t.attemptId, "failed", t.lastSeq || null);
  try {
    await deps.client.fail(work, reason);
  } catch (err) {
    if (isLeaseSuperseded(err) || isForeignRun(err)) {
      return await abort(deps, key, work, t.attemptId, err);
    }
    t.log("the board could not be told the question went unanswered", { run: work.runId, error: String(err) });
  }
  await afterTheBoardWasTold(deps, "the card was failed", () => markAbandoned(key, reason));
  t.log("a permission request went unanswered", { run: work.runId, card: key.externalCardId, reason });
  return { status: "unanswered", externalRunId: work.runId, attemptId: t.attemptId ?? undefined, reason };
}

/** The work is done: record it, then tell the board. */
async function reportCompleted(t: Turn): Promise<DispatchResult> {
  const { deps, key, work } = t;
  const contextPeak = t.coalescer.contextPeak();
  const handoff = {
    summary: t.said.join("").slice(0, SUMMARY_LIMIT) || null,
    station: deps.agent.stationId,
    session: t.session.id,
    attempt: t.attemptId,
    // Context occupancy, not cost: no harness reports tokens or money over ACP.
    ...(contextPeak ? { contextPeak } : {}),
  };

  // Written BEFORE the board is told. A bridge that dies between these two
  // leaves a recoverable fact instead of a card that will be worked twice.
  await recordProduced(key, handoff);
  if (t.attemptId) await endAttempt(t.attemptId, "completed", t.lastSeq);
  await deps.acp.endSession(deps.agent.hubUserId, t.session.id, "The board's card is complete.").catch(() => {});

  try {
    await deps.client.complete(work, handoff);
  } catch (err) {
    // A stale lease here may mean the agent completed the run itself a moment ago; `abort`
    // is where that is decided, for every path that reaches it.
    if (isLeaseSuperseded(err) || isForeignRun(err)) {
      return await abort(deps, key, work, t.attemptId, err);
    }
    // The work is done and recorded; the board just did not hear. The next
    // claim of this card replays it — which is the whole point of writing the
    // output down first.
    t.log("the board could not be told; the output is recorded for replay", { run: work.runId, error: String(err) });
    return { status: "unreported", externalRunId: work.runId, attemptId: t.attemptId ?? undefined, reason: String(err) };
  }

  await afterTheBoardWasTold(deps, "the card was completed", () => markReported(key));
  return { status: "reported", externalRunId: work.runId, attemptId: t.attemptId ?? undefined };
}
