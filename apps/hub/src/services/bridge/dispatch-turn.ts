/**
 * The turn of a claimed card, once its session is open: the state one dispatch holds, the ordered
 * board queue, the event subscriber, the heartbeat, the question asked of a human, and the loop
 * that runs the turn segment by segment. Split out of dispatch.ts's `workClaimed`, unchanged: what
 * were its local variables are the fields of `Turn`, and what were its closures take the turn.
 */

import { context, trace } from "@opentelemetry/api";
import type { AcpEvent } from "@agentpod/contract";

import { ActivityCoalescer, type BoardActivity } from "./coalesce";
import type { AgentSpanRecorder } from "../../telemetry/agent-spans";
import { attemptSpanFacts } from "./attempt-facts";
import type { Fingerprint } from "../evidence";
import { fingerprintWithin, resolveStationFingerprint } from "../evidence";
import { DEFAULT_PERMISSION_WAIT_MS } from "./config";
import { boardPermissionSubject, isAutoAnswered, selectedOptionId, withoutApprovals } from "./permission";
import { isEnvelopeRefusal, isForeignRun, isLeaseSuperseded, type ClaimedWork, type RunElicitation } from "./superpipeline";
import { clearPermissionWait, recordPermissionWait, startAttempt, type CoalescingCounts, type DispatchKey } from "./ledger";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PERMISSION_POLL_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  type DispatchDeps,
  type PermissionResolution,
  type TurnEnd,
} from "./dispatch-types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything one dispatch holds while its session is open. */
export interface Turn {
  deps: DispatchDeps;
  work: ClaimedWork;
  key: DispatchKey;
  session: { id: string; libraryTools?: boolean };
  spans: AgentSpanRecorder;
  log: (message: string, meta?: Record<string, unknown>) => void;
  occupantForAttempt: () => Promise<string | null>;
  coalescer: ActivityCoalescer;
  attemptId: string | null;
  /** The fingerprint the attempt opened with. ws4's `attempt` span reads `.digest` from here. */
  attemptFingerprint: Fingerprint | null;
  attemptStarted: boolean;
  lastSeq: number;
  said: string[];
  /**
   * Requirement 5's two numbers (see the header). Counted here rather than
   * inside the coalescer because the pair only means anything together, and one
   * of them — what left for the board — is this function's business, not the
   * projection's. Both are plain integers held for the length of one dispatch;
   * nothing accumulates per event.
   */
  counts: CoalescingCounts;
  // Hoisted so the failure exit can tear them down: a throw must not
  // leave a live subscription and a heartbeat still beating for a run that is
  // over. Both are idempotent, so the happy path's own cleanup still stands.
  unsubscribe: () => void;
  beat: ReturnType<typeof setInterval> | null;
  timer: ReturnType<typeof setTimeout> | null;
  settle: (end: TurnEnd) => void;
  turn: Promise<TurnEnd>;
  /** Questions this run has already asked. Keeps a poll off an older one. */
  asked: Set<string>;
  /**
   * A lost lease learned late still ends the run.
   *
   * Posts are queued, so a 409 can surface *after* the harness has already
   * yielded and the turn has settled as "yielded". Latching it here rather than
   * relying on the race means the outcome does not depend on whether the board
   * answered before or after the last event arrived — and the alternative is a
   * `complete` sent on a card somebody else now holds.
   */
  abortCause: "lease-superseded" | "foreign-run" | null;
  // Posts are serialized so activities reach the board in transcript order —
  // the same reason acp-sessions chains its own writes.
  chain: Promise<void>;
}

export function newTurn(
  deps: DispatchDeps,
  work: ClaimedWork,
  key: DispatchKey,
  session: { id: string; libraryTools?: boolean },
  spans: AgentSpanRecorder,
  occupantForAttempt: () => Promise<string | null>,
): Turn {
  return {
    deps,
    work,
    key,
    session,
    spans,
    log: deps.log ?? (() => {}),
    occupantForAttempt,
    coalescer: new ActivityCoalescer(),
    attemptId: null,
    attemptFingerprint: null,
    attemptStarted: false,
    lastSeq: 0,
    said: [],
    counts: { eventsReceived: 0, activitiesPosted: 0 },
    unsubscribe: () => {},
    beat: null,
    timer: null,
    settle: () => {},
    turn: Promise.resolve({ kind: "yielded" }),
    asked: new Set<string>(),
    abortCause: null,
    chain: Promise.resolve(),
  };
}

/**
 * Why the harness was never given a decision, in words that go to the board,
 * the ledger and the log alike.
 *
 * Every one of them ends the run rather than guessing. An unanswered question
 * is not a reason to pick an option on a human's behalf: the whole point of
 * asking was that something in this run needed a person.
 */
function whyNoAnswer(resolution: PermissionResolution): string {
  switch (resolution.kind) {
    case "timeout":
      return resolution.expired
        ? "the agent asked for permission and nobody answered before the request expired"
        : `the agent asked for permission and nobody answered within ${Math.round(resolution.waitMs / 1000)}s`;
    case "cancelled":
      return "the agent asked for permission and the question was cancelled before it was answered — its run ended, its card moved, or a newer question superseded it";
    case "unmappable":
      return "the agent asked for permission and the answer named no option the harness had offered, so there was no decision to deliver";
    case "unrecorded":
      return "the agent asked for permission and the board has no record of the question, so nobody could answer it";
    default:
      return "the agent asked for permission and no answer could be delivered";
  }
}

// ─── the turn, in segments ───────────────────────────────────────────────
// A permission request splits a turn in two: the harness stops, a human
// decides, and the harness carries on. Each stretch of agent work is its own
// segment with its own deadline, because the minutes a human spends deciding
// are not minutes the harness spent working and must not be charged against
// its time limit — a person who answers promptly should not lose the run to
// a budget the waiting itself consumed.
export function openSegment(t: Turn): void {
  let done = false;
  t.turn = new Promise<TurnEnd>((resolve) => {
    t.settle = (end) => {
      if (done) return;
      done = true;
      resolve(end);
    };
  });
}

export function queue(t: Turn, fn: () => Promise<void>): void {
  t.chain = t.chain.then(fn).catch((err) => {
    if (isLeaseSuperseded(err)) {
      t.abortCause ??= "lease-superseded";
      return t.settle({ kind: "lease-superseded" });
    }
    if (isForeignRun(err)) {
      t.abortCause ??= "foreign-run";
      return t.settle({ kind: "foreign-run" });
    }
    // Anything else is transient: a dropped activity is not worth ending a
    // run over, and the board's own ordering is by its `seq`, not ours.
    t.log("activity post failed", { error: String(err) });
  });
}

export function post(t: Turn, activities: BoardActivity[]): void {
  for (const a of activities) {
    if (a.type === "response" && a.body) t.said.push(a.body);
    // Counted where the activity is sent, not where the board acknowledges
    // it: this number answers "how much did the transcript collapse to",
    // and a 502 on the wire is a delivery question. The queue logs those
    // separately, and coalescing is what bounds how many there can be.
    t.counts.activitiesPosted++;
    queue(t, () => postActivity(t, a));
  }
}

/**
 * Post one activity. A board that refuses a permission question's envelope (its meanings or its
 * subject) understands the envelope, so it gets the question again, once, with its approving
 * options removed (`withoutApprovals`) — never an approvable question bound to nothing. A board
 * that predates the envelope ignores it and never refuses. Any other refusal is the queue's.
 */
async function postActivity(t: Turn, a: BoardActivity): Promise<void> {
  try {
    await t.deps.client.activity(t.work, a);
  } catch (err) {
    const declineOnly = withoutApprovals(a);
    if (!declineOnly || !isEnvelopeRefusal(err)) throw err;
    t.log("the board refused a permission question's envelope; posted it decline-only", { error: String(err) });
    await t.deps.client.activity(t.work, declineOnly);
  }
}

/** The run join, written as soon as the attempt has a first seq. Runs in the post queue. */
async function startTheAttempt(t: Turn, event: AcpEvent, recording: boolean): Promise<void> {
  const { deps, key, log, spans } = t;
  const { tenantId, agent } = deps;
  const resolve = deps.fingerprint ?? ((i) => resolveStationFingerprint(i.tenantId, i.stationId));
  const at = { tenantId, stationId: agent.stationId };
  const [fingerprint, agentPrincipalId] = await Promise.all([fingerprintWithin(() => resolve(at)), t.occupantForAttempt()]);
  if (agentPrincipalId === null) {
    // Null covers no occupant, a lookup that timed out and one that threw; the resolver logs
    // a throw itself. Say so here so an operator can tell why agent_principal_id is empty.
    try {
      log("attempt opened without an agent principal (no occupant, or lookup late/failed)", {
        station: agent.stationId,
      });
    } catch {
      // a broken sink must never cost the attempt row
    }
  }
  t.attemptFingerprint = fingerprint;
  const startedId = await startAttempt({
    ...key,
    sessionId: t.session.id,
    stationId: agent.stationId,
    startSeq: event.seq,
    fingerprint,
    agentPrincipalId,
  });
  t.attemptId = startedId;
  try {
    // With telemetry off nothing records the attempt: skip the extra read entirely.
    if (!recording) return;
    const facts = await attemptSpanFacts(startedId).catch(() => ({ fingerprintDigest: "unknown", harnessName: "unknown" }));
    spans.openAttempt({ attemptId: startedId, sessionId: t.session.id, startSeq: event.seq, ...facts });
  } catch {
    // products never block on telemetry
  }
}

function onTurnEvent(t: Turn, event: AcpEvent, recording: boolean): void {
  try {
    t.spans.onEvent(event);
  } catch {
    // products never block on telemetry
  }
  t.lastSeq = Math.max(t.lastSeq, event.seq);
  // Every event, before any branch drops one — this is the number an
  // operator can cross-check against `SELECT count(*) FROM acp_events`.
  t.counts.eventsReceived++;

  if (t.attemptId === null && !t.attemptStarted) {
    t.attemptStarted = true;
    queue(t, () => startTheAttempt(t, event, recording));
  }

  // A request the hub answered itself — `full-auto` on anything,
  // `accept-edits` on an edit — is not a question. Nothing is parked on it,
  // so stopping the turn for one would wait for an answer that can never
  // arrive. It falls through and projects as an ordinary activity.
  if (event.type === "permission-request" && !isAutoAnswered(event.payload)) {
    post(t, t.coalescer.push(event));
    return t.settle({ kind: "permission-required", event });
  }

  if (event.type === "state") {
    const status = (event.payload as { status?: string } | null)?.status;
    if (status === "idle") return t.settle({ kind: "yielded" });
    if (status === "ended") {
      // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- a payload from the wire: `reason` is not proven a string
      const reason = String((event.payload as { reason?: string } | null)?.reason ?? "session ended");
      return t.settle({ kind: "session-ended", reason });
    }
    return;
  }

  post(t, t.coalescer.push(event));
}

export function subscribeTurn(t: Turn): void {
  // In production the broker's WebSocket handler fires this outside the dispatch span's async
  // context, so run the body inside the context captured here: board calls queued from it keep
  // the run's traceparent.
  const dispatchCtx = context.active();
  const recording = trace.getSpan(dispatchCtx)?.isRecording() === true;
  t.unsubscribe = t.deps.acp.subscribe(t.session.id, (event) =>
    context.with(dispatchCtx, () => onTurnEvent(t, event, recording)),
  );
}

export function startHeartbeat(t: Turn): void {
  const { deps, work } = t;
  // Started before the turn and stopped only when every segment is over —
  // including the stretches spent waiting on a person. superpipeline reclaims a
  // lease that goes quiet for 15 minutes; a waiting lease is not quiet, which
  // is exactly why the wait can be bounded by policy instead of by the lease.
  t.beat = setInterval(() => {
    queue(t, async () => {
      await deps.client.heartbeat(work);
      await deps.acp.renewExecution?.(deps.agent.hubUserId, t.session.id, { source: 'superpipeline', id: work.runId, epoch: work.leaseEpoch });
    });
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
}

/**
 * Ask a human, and wait.
 *
 * The question itself is already on its way: the subscriber pushed the
 * request through the coalescer and into the same ordered queue as every
 * other activity, so it reaches the board after everything the agent said
 * before it stopped to ask. This drains that queue, then reads the run back
 * until the question is settled — the read surface is authorized by the run
 * this agent already owns, so no second credential and no re-claim.
 */
async function askTheHuman(t: Turn, request: AcpEvent): Promise<PermissionResolution> {
  const { deps, work } = t;
  await t.chain;
  if (t.abortCause) return { kind: "aborted" };

  const waitMs = deps.permissionWaitMs ?? deps.agent.permissionWaitMs ?? DEFAULT_PERMISSION_WAIT_MS;
  const pollMs = deps.permissionPollMs ?? DEFAULT_PERMISSION_POLL_MS;
  // Bounded by the earlier of the agent's limit and the request's own expiry (charter: "Unanswered
  // decisions remind, then escalate" §8): past `expires_at` the board refuses an approval of it
  // anyway, so waiting longer holds the harness for an answer that cannot count.
  const expiresAt = Date.parse(boardPermissionSubject(t.session.id, request.seq, request.payload, request.createdAt).expires_at);
  const deadline = Number.isFinite(expiresAt) ? Math.min(Date.now() + waitMs, expiresAt) : Date.now() + waitMs;
  const expired = Number.isFinite(expiresAt) && expiresAt < Date.now() + waitMs;
  // Recorded so a restart that cuts the wait short is noticed and the run ended (`dispatch-recover.ts`).
  await recordPermissionWait(t.key, { sessionId: t.session.id, requestSeq: request.seq, until: new Date(deadline) });
  const offered = (request.payload as { options?: unknown } | null)?.options;
  let questionId: string | null = null;

  for (;;) {
    const elicitations = (await deps.client.context(work.runId)).elicitations ?? [];
    // Identified by id from the first read on, not by "the last one": this
    // run may have asked before, and a question that is answered is not
    // re-answerable. Nothing is inferred from position after that.
    const question: RunElicitation | undefined = questionId
      ? elicitations.find((e) => e.id === questionId)
      : elicitations.filter((e) => !t.asked.has(e.id)).at(-1);
    if (!question) return { kind: "unrecorded" };
    questionId = question.id;
    t.asked.add(question.id);

    if (question.status === "cancelled") return { kind: "cancelled" };
    if (question.status === "answered") {
      const optionId = selectedOptionId(offered, question.answer);
      // Null means the answer selected nothing the harness offered — free
      // text, or an option from somewhere else. Not a decision, and not a
      // reason to pick one.
      if (optionId === null) return { kind: "unmappable" };
      const by = question.answer?.answeredBy;
      return by
        ? { kind: "answered", optionId, answeredBy: { boardUserId: by, principalId: question.answer?.answeredByPrincipal ?? null } }
        : { kind: "answered", optionId };
    }

    if (t.abortCause) return { kind: "aborted" };
    if (Date.now() >= deadline) return { kind: "timeout", waitMs, expired };
    await sleep(pollMs);
  }
}

/**
 * One segment: the turn as it stands, raced against the segment's deadline.
 */
async function awaitSegment(t: Turn): Promise<TurnEnd> {
  const segment = t.turn;
  const timeout = new Promise<TurnEnd>((resolve) => {
    t.timer = setTimeout(() => resolve({ kind: "timeout" }), t.deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
  });
  const end = await Promise.race([segment, timeout]);
  if (t.timer) {
    clearTimeout(t.timer);
    t.timer = null;
  }
  return end;
}

/**
 * The harness is parked on `request`: ask, and either deliver the answer (null: the turn goes
 * on) or say how the turn ended instead.
 */
async function resolvePermission(t: Turn, request: AcpEvent): Promise<TurnEnd | null> {
  const { deps, work, key } = t;
  // Opened BEFORE the wait so the harness is not deaf while a human
  // thinks: an event that arrives now — a session that died, above all —
  // settles the next segment instead of being dropped into a settled one.
  openSegment(t);
  const outcome = await Promise.race([
    askTheHuman(t, request).then((resolution) => ({ resolution })),
    t.turn.then((interrupted) => ({ interrupted })),
  ]);
  // The wait is over however it ended: answered, given up on, or the turn interrupted it.
  await clearPermissionWait(t.key).catch(() => {});

  if ("interrupted" in outcome) return outcome.interrupted;
  if (outcome.resolution.kind !== "answered") {
    return { kind: "unanswered", reason: whyNoAnswer(outcome.resolution) };
  }
  t.log("a human answered a permission request", {
    run: work.runId,
    card: key.externalCardId,
    option: outcome.resolution.optionId,
  });
  // Who answered is recorded on the session's permission-answer (charter 2026-11-07 §6).
  const by = outcome.resolution.answeredBy;
  await deps.acp.answerPermission(
    deps.agent.hubUserId,
    t.session.id,
    request.seq,
    outcome.resolution.optionId,
    ...(by ? [{ via: "board" as const, principalId: by.principalId, userId: by.boardUserId }] : []),
  );
  return null;
}

/** Prompt the harness and run the turn, segment by segment, to its end. */
export async function driveTurn(t: Turn, text: string): Promise<TurnEnd> {
  const { deps, work } = t;
  let end: TurnEnd;
  try {
    if (deps.acp.renewExecution) await deps.client.heartbeat(work);
    await deps.acp.promptSession(deps.agent.hubUserId, t.session.id, text, { source: 'superpipeline', id: work.runId, epoch: work.leaseEpoch });
    for (;;) {
      end = await awaitSegment(t);
      if (end.kind !== "permission-required") break;
      const interrupted = await resolvePermission(t, end.event);
      if (interrupted) {
        end = interrupted;
        break;
      }
    }
  } finally {
    if (t.timer) clearTimeout(t.timer);
    if (t.beat) clearInterval(t.beat);
  }
  return end;
}
