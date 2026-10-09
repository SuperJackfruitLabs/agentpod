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
 * 1. **A 409 ends the ACP session.** superpipeline fences its own state — the
 *    reclaim experiment came back with `leaseEpoch: 2` and the old run locked
 *    out of every write. But nothing fences the *machine*: the original harness
 *    kept executing with no idea its lease had been revoked, and in a task that
 *    outlives the 15-minute reclaim two harnesses would be writing the same
 *    directory while superpipeline correctly ignored one of them. The lease is
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
 *
 * A sixth arrived the same way, on the next real card. The agent wrote two
 * files, asked permission to run the tests, and the run ended `abandoned` with
 * "the agent asked for permission, which the board cannot answer" — partial work
 * left in the workspace, card parked. `accept-edits` auto-approves file writes
 * and NOT command execution, so every card whose work involved running
 * something died exactly there.
 *
 * 6. **A permission request is a question, and the bridge waits for the
 *    answer.** superpipeline PR #36 built the return path, so the request becomes an
 *    elicitation carrying its options, the bridge heartbeats while a human
 *    decides, and the answer is delivered to the harness on the same lease —
 *    the run never lets go of the card to ask. The wait is bounded by policy
 *    (`permissionWaitMs`), not by the lease, because a heartbeating lease is
 *    never reclaimed. See `askTheHuman`.
 */

import { context, trace } from "@opentelemetry/api";
import { CARD_PROMPT_VERSION, CardPrompt, CardPromptComment, renderCardPrompt, type AcpEvent, type AcpMcpServer, type AcpSessionMode, type CardPromptRelated } from "@agentpod/contract";

import { ActivityCoalescer, type BoardActivity } from "./coalesce";
import type { AgentSpanRecorder } from "../../telemetry/agent-spans";
import { attemptSpanFacts } from "../../telemetry/attempt-facts";
import { inDispatchSpan } from "../../telemetry/dispatch-span";
import { isControlPairDenied } from "../control-pair";
import type { Fingerprint } from "../evidence/fingerprint";
import { fingerprintWithin, resolveStationFingerprint, resolveStationOccupant, within } from "../evidence/station-fingerprint";
import { fetchRelatedWork, prefetchRelatedWork, relatedWorkEnabled } from "../superlibrary/related";
import { DEFAULT_PERMISSION_WAIT_MS, type BridgeAgentConfig } from "./config";
import { isAutoAnswered, selectedOptionId } from "./permission";
import {
  isForeignRun,
  isLeaseSuperseded,
  SuperpipelineClient,
  type ClaimedWork,
  type RunContext,
  type RunElicitation,
} from "./superpipeline";
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
  /**
   * `mcpProxy` asks the station's node to add its loopback MCP proxy — the hub's MCP server and
   * Superlibrary's, reached as the station's own agent — to the session. `libraryTools` in the
   * answer is true only when the node said it injected both; the card prompt names their tools
   * on that alone.
   */
  createSession(input: {
    stationId: string;
    userId: string;
    mode: AcpSessionMode;
    mcpServers?: AcpMcpServer[];
    mcpProxy?: boolean;
  }): Promise<{ id: string; libraryTools?: boolean }>;
  promptSession(userId: string, sessionId: string, text: string): Promise<void>;
  subscribe(sessionId: string, fn: (e: AcpEvent) => void): () => void;
  endSession(userId: string, sessionId: string, reason: string): Promise<void>;
  /**
   * Deliver a decision to the harness parked on `requestSeq`.
   *
   * `optionId` is ACP's own identifier for the option, and it is delivered
   * verbatim: an allow option allows, a reject option rejects. Nothing here
   * interprets which is which, because a bridge that decided what a human's
   * choice "really meant" is the failure this whole path exists to avoid.
   */
  answerPermission(userId: string, sessionId: string, requestSeq: number, optionId: string): Promise<void>;
}

export interface DispatchDeps {
  client: SuperpipelineClient;
  acp: AcpPort;
  agent: BridgeAgentConfig;
  tenantId: string;
  source: string;
  heartbeatMs?: number;
  turnTimeoutMs?: number;
  /** Overrides the agent's own `permissionWaitMs`. A test seam. */
  permissionWaitMs?: number;
  /** How often the run is re-read while a question is outstanding. */
  permissionPollMs?: number;
  /**
   * superpipeline's MCP endpoint, for the agent's own board tools. Together with
   * the agent's `mcpToken` it is what makes a harness able to report for
   * itself; either one missing means it cannot, and is told nothing about it.
   */
  mcpUrl?: string;
  /**
   * What executed the attempt (contract C3). A seam so a test can state one; defaults to
   * `resolveStationFingerprint`. Bounded by `fingerprintWithin`, so a slow or failing resolver
   * opens the attempt with the all-unknown fingerprint instead of holding the turn. It is awaited
   * inside the serial post queue, so board posts may lag by up to `FINGERPRINT_TIMEOUT_MS`; the
   * ACP turn itself is never held.
   *
   * The one lookup that can come before the turn is `relatedWork`'s, and only when related work is
   * on (Superlibrary configured and the board's switch on): then the occupant lookup (`within`,
   * up to `FINGERPRINT_TIMEOUT_MS`, 2 s) and the related call share `RELATED_TIMEOUT_MS`, so the
   * worst-case delay before the session opens is 2.5 s, not 2 s + 2.5 s. With related work off or
   * unconfigured nothing is awaited before the session beyond the switch read.
   */
  fingerprint?: (input: { tenantId: string; stationId: string }) => Promise<Fingerprint>;
  /** Who the station runs as (contract C5). A seam; defaults to `resolveStationOccupant`, bounded by `within`. */
  occupant?: (input: { tenantId: string; stationId: string }) => Promise<string | null>;
  /**
   * Superlibrary's related prior work for the card, as the station's agent may see it. A seam;
   * defaults to `fetchRelatedWork`, which answers `undefined` whenever the section should be left
   * out (Superlibrary unconfigured, the board switched off, no principal, any failure or lateness).
   */
  relatedWork?: (input: {
    tenantId: string;
    boardId: string;
    cardId: string;
    /** A lookup, awaited only if related work will actually be fetched. */
    principal: string | null | (() => Promise<string | null>);
    enabled?: () => Promise<boolean>;
  }) => Promise<CardPromptRelated[] | undefined>;
  /** Starts minting the agent's Superlibrary token. A seam; defaults to `prefetchRelatedWork`. Fire-and-forget. */
  prefetchRelated?: (input: {
    tenantId: string;
    boardId: string;
    cardId: string;
    principal: string | null | (() => Promise<string | null>);
    enabled?: () => Promise<boolean>;
  }) => void;
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
  /**
   * Worked, and the AGENT told the board — the bridge's own report arrived
   * second and was refused. Its own status rather than a flavour of `reported`,
   * because the two differ in who authored the card's outcome, and that is the
   * fact an operator reading the ledger is trying to establish.
   */
  | "self-reported"
  /** Worked; the board could not be told. Recoverable — the output is recorded. */
  | "unreported"
  /** The lease lapsed mid-run. The harness was stopped. */
  | "lease-superseded"
  /** The run belongs to another agent. A bug: the loop must not continue. */
  | "foreign-run"
  /**
   * A question was asked and no answer came back that could be delivered —
   * nobody answered in time, the question was cancelled, or what came back
   * named no option the harness had offered. Its own status rather than a
   * flavour of `failed`, because "a human did not answer" is an operational
   * fact about the board and "the harness broke" is not.
   */
  | "unanswered"
  /** The harness or the session failed. */
  | "failed";

export interface DispatchResult {
  status: DispatchStatus;
  externalRunId?: string;
  attemptId?: string;
  reason?: string;
}

/** superpipeline reclaims at 15 minutes; RQ3 measured 12.3s as the longest silence. */
const DEFAULT_HEARTBEAT_MS = 60_000;
/** A harness that never yields still has to end somewhere. */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
/** How often a run with a question outstanding is re-read. */
const DEFAULT_PERMISSION_POLL_MS = 10_000;
/** How much of what the agent said rides in the handoff. */
const SUMMARY_LIMIT = 4_000;

/** Why a turn stopped, as far as the event stream is concerned. */
type TurnEnd =
  | { kind: "yielded" }
  | { kind: "session-ended"; reason: string }
  | { kind: "lease-superseded" }
  | { kind: "foreign-run" }
  /** The harness is parked on a decision. `event` is the request it is parked on. */
  | { kind: "permission-required"; event: AcpEvent }
  /** A question was asked and no deliverable answer came back. */
  | { kind: "unanswered"; reason: string }
  | { kind: "timeout" };

/** How a question ended. Only `answered` resumes the harness. */
type PermissionResolution =
  | { kind: "answered"; optionId: string }
  /** superpipeline cancelled it: the run ended, the card moved, or it was superseded. */
  | { kind: "cancelled" }
  /** Answered, but with nothing that maps to an option the harness offered. */
  | { kind: "unmappable" }
  /** The board has no record of the question, so nobody can be asked it. */
  | { kind: "unrecorded" }
  | { kind: "timeout"; waitMs: number }
  /** The lease went while we waited. The abort path owns the outcome. */
  | { kind: "aborted" };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
      return `the agent asked for permission and nobody answered within ${Math.round(resolution.waitMs / 1000)}s`;
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

/**
 * How long the readiness probe may take before the station counts as not ready.
 *
 * The probe asks a node over the broker whether its station can run work. That is a question
 * about *right now*, so a slow answer is not a useful answer — and an unbounded one is worse
 * than useless: on 2026-09-08 the bridge logged a single cycle and then nothing at all, for
 * hours, because this call never returned. The loop was neither erroring nor idling; it was
 * never coming back, which is the one failure shape that looks exactly like a quiet fleet.
 *
 * **A timed-out probe is a negative answer, not an error.** If a station cannot say it is ready
 * within ten seconds, it is not ready, and the loop's ordinary not-ready backoff is the correct
 * response. That keeps the failure inside the state machine that already handles it.
 */
export const READINESS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Bounded readiness. Deliberately narrow: this is the ONE call in a cycle that must be fast.
 *
 * The claim itself is bounded by `fetchAdapter`'s own signal, and everything after it — the
 * session, the prompt, the activity stream — is the agent's work, which legitimately takes as
 * long as it takes. Bounding the whole cycle would abandon a running agent mid-task.
 */
async function probeReadiness(
  acp: AcpPort,
  agent: { stationId: string; hubUserId: string },
): Promise<{ ready: boolean; reason?: string }> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ ready: boolean; reason?: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ready: false, reason: `the station did not answer a readiness probe within ${READINESS_PROBE_TIMEOUT_MS}ms` }),
      READINESS_PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      acp.stationReady({ stationId: agent.stationId, userId: agent.hubUserId }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function runOnce(deps: DispatchDeps): Promise<DispatchResult> {
  const { client, acp, agent } = deps;
  const log = deps.log ?? (() => {});

  // ─── requirement 4a: do not claim work there is nowhere to run ─────────────
  // The board hands out a card on a claim; the hub cannot un-hand it for 15
  // minutes except by asking. Checking first is what removes the race entirely,
  // including the restart case that produced it — the bridge starts with the
  // hub, the node-agents dial back in seconds later.
  const readiness = await probeReadiness(acp, agent);
  if (!readiness.ready) {
    const reason = readiness.reason ?? "the station cannot run work right now";
    log("not claiming: the station is not ready", { station: agent.stationId, reason });
    return { status: "not-ready", reason };
  }

  const claimedAt = new Date();
  const work = await client.claim({ maxConcurrency: agent.maxConcurrency, profileKey: agent.profileKey });
  // A bare "not claimed" covers an empty queue, an over-budget board and an
  // agent at its concurrency cap alike. superpipeline does not say which.
  if (!work) return { status: "idle" };

  return inDispatchSpan(
    { runId: work.runId, boardId: agent.boardId, cardId: work.card.id, source: deps.source, stationId: agent.stationId, startTime: claimedAt },
    (spans) => workClaimed(deps, work, spans),
  );
}

/** Everything after a successful claim. Runs inside the run's `dispatch` span. */
async function workClaimed(deps: DispatchDeps, work: ClaimedWork, spans: AgentSpanRecorder): Promise<DispatchResult> {
  const { client, acp, agent, tenantId, source } = deps;
  const log = deps.log ?? (() => {});

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
  // Who the station runs as. The related section needs it before the session opens, but only
  // when related work will actually be fetched (Superlibrary configured, the board switched on):
  // the prompt passes this as a lookup, which `fetchRelatedWork` awaits only then, inside its own
  // deadline. Otherwise nothing is looked up before the session and the attempt does the lookup at
  // its first ACP event, as it always has. An attempt reuses an answer the prompt already got; a
  // null one (no occupant, late, failed) is looked up again at the attempt, as it was before.
  // Each lookup is bounded by `within`, so a late or failed one is null and never holds the turn.
  const resolveOccupant = deps.occupant ?? ((i) => resolveStationOccupant(i.tenantId, i.stationId));
  const lookUpOccupant = () => within(() => resolveOccupant({ tenantId, stationId: agent.stationId }), null);
  let promptLookup: Promise<string | null> | null = null;
  const occupantForPrompt = (): Promise<string | null> => (promptLookup ??= lookUpOccupant());
  const occupantForAttempt = async (): Promise<string | null> =>
    (promptLookup ? await promptLookup : null) ?? lookUpOccupant();

  let text: string;
  let session: { id: string; libraryTools?: boolean };
  try {
    await openDispatch({ ...key, agentKey: agent.key, stationId: agent.stationId, leaseEpoch: work.leaseEpoch });

    // ─── requirement 3: check for prior output BEFORE starting work ──────────
    const prior = await findUnreportedOutput(key);
    if (prior) return await replay(deps, key, work, prior);

    // ─── the prompt contract ────────────────────────────────────────────────
    const prompt = await assemblePrompt(deps, work, occupantForPrompt);

    // ─── the session ────────────────────────────────────────────────────────
    // Always asks for the node's MCP proxy: the node decides (a station its operator named, a
    // harness that takes HTTP MCP servers) and says what it injected.
    session = await acp.createSession({
      stationId: agent.stationId,
      userId: agent.hubUserId,
      mode: agent.mode,
      ...(boardTools(deps) ? { mcpServers: boardTools(deps)! } : {}),
      mcpProxy: true,
    });
    // Rendered after the session opens, because only the open says which tools it carries (S3-R12).
    text = renderCardPrompt({ ...prompt, libraryTools: session.libraryTools === true });
  } catch (err) {
    return await handBack(deps, key, work, err);
  }

  const coalescer = new ActivityCoalescer();
  let attemptId: string | null = null;
  /** The fingerprint the attempt opened with. ws4's `attempt` span reads `.digest` from here. */
  let attemptFingerprint: Fingerprint | null = null;
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
    // ─── the turn, in segments ───────────────────────────────────────────────
    // A permission request splits a turn in two: the harness stops, a human
    // decides, and the harness carries on. Each stretch of agent work is its own
    // segment with its own deadline, because the minutes a human spends deciding
    // are not minutes the harness spent working and must not be charged against
    // its time limit — a person who answers promptly should not lose the run to
    // a budget the waiting itself consumed.
    let settle: (end: TurnEnd) => void = () => {};
    let turn!: Promise<TurnEnd>;
    const openSegment = (): void => {
      let done = false;
      turn = new Promise<TurnEnd>((resolve) => {
        settle = (end) => {
          if (done) return;
          done = true;
          resolve(end);
        };
      });
    };
    openSegment();

    /** Questions this run has already asked. Keeps a poll off an older one. */
    const asked = new Set<string>();

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

    // In production the broker's WebSocket handler fires this outside the dispatch span's async
    // context, so run the body inside the context captured here: board calls queued from it keep
    // the run's traceparent.
    const dispatchCtx = context.active();
    const recording = trace.getSpan(dispatchCtx)?.isRecording() === true;
    unsubscribe = acp.subscribe(session.id, (event) => context.with(dispatchCtx, () => {
      try {
        spans.onEvent(event);
      } catch {
        // products never block on telemetry
      }
      lastSeq = Math.max(lastSeq, event.seq);
      // Every event, before any branch drops one — this is the number an
      // operator can cross-check against `SELECT count(*) FROM acp_events`.
      counts.eventsReceived++;

      if (attemptId === null && !attemptStarted) {
        attemptStarted = true;
        // The run join, written as soon as the attempt has a first seq.
        queue(async () => {
          const resolve = deps.fingerprint ?? ((i) => resolveStationFingerprint(i.tenantId, i.stationId));
          const at = { tenantId, stationId: agent.stationId };
          const [fingerprint, agentPrincipalId] = await Promise.all([fingerprintWithin(() => resolve(at)), occupantForAttempt()]);
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
          attemptFingerprint = fingerprint;
          const startedId = await startAttempt({
            ...key,
            sessionId: session.id,
            stationId: agent.stationId,
            startSeq: event.seq,
            fingerprint,
            agentPrincipalId,
          });
          attemptId = startedId;
          try {
            // With telemetry off nothing records the attempt: skip the extra read entirely.
            if (!recording) return;
            const facts = await attemptSpanFacts(startedId).catch(() => ({ fingerprintDigest: "unknown", harnessName: "unknown" }));
            spans.openAttempt({ attemptId: startedId, sessionId: session.id, startSeq: event.seq, ...facts });
          } catch {
            // products never block on telemetry
          }
        });
      }

      // A request the hub answered itself — `full-auto` on anything,
      // `accept-edits` on an edit — is not a question. Nothing is parked on it,
      // so stopping the turn for one would wait for an answer that can never
      // arrive. It falls through and projects as an ordinary activity.
      if (event.type === "permission-request" && !isAutoAnswered(event.payload)) {
        post(coalescer.push(event));
        return settle({ kind: "permission-required", event });
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
    }));
    let attemptStarted = false;

    // Started before the turn and stopped only when every segment is over —
    // including the stretches spent waiting on a person. superpipeline reclaims a
    // lease that goes quiet for 15 minutes; a waiting lease is not quiet, which
    // is exactly why the wait can be bounded by policy instead of by the lease.
    beat = setInterval(() => {
      queue(async () => {
        await client.heartbeat(work);
      });
    }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

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
    const askTheHuman = async (request: AcpEvent): Promise<PermissionResolution> => {
      await chain;
      if (abortCause) return { kind: "aborted" };

      const waitMs = deps.permissionWaitMs ?? agent.permissionWaitMs ?? DEFAULT_PERMISSION_WAIT_MS;
      const pollMs = deps.permissionPollMs ?? DEFAULT_PERMISSION_POLL_MS;
      const deadline = Date.now() + waitMs;
      const offered = (request.payload as { options?: unknown } | null)?.options;
      let questionId: string | null = null;

      for (;;) {
        const elicitations = (await client.context(work.runId)).elicitations ?? [];
        // Identified by id from the first read on, not by "the last one": this
        // run may have asked before, and a question that is answered is not
        // re-answerable. Nothing is inferred from position after that.
        const question: RunElicitation | undefined = questionId
          ? elicitations.find((e) => e.id === questionId)
          : elicitations.filter((e) => !asked.has(e.id)).at(-1);
        if (!question) return { kind: "unrecorded" };
        questionId = question.id;
        asked.add(question.id);

        if (question.status === "cancelled") return { kind: "cancelled" };
        if (question.status === "answered") {
          const optionId = selectedOptionId(offered, question.answer);
          // Null means the answer selected nothing the harness offered — free
          // text, or an option from somewhere else. Not a decision, and not a
          // reason to pick one.
          return optionId === null ? { kind: "unmappable" } : { kind: "answered", optionId };
        }

        if (abortCause) return { kind: "aborted" };
        if (Date.now() >= deadline) return { kind: "timeout", waitMs };
        await sleep(pollMs);
      }
    };

    let end: TurnEnd;
    try {
      await acp.promptSession(agent.hubUserId, session.id, text);
      for (;;) {
        const segment = turn;
        const timeout = new Promise<TurnEnd>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
        });
        end = await Promise.race([segment, timeout]);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (end.kind !== "permission-required") break;
        const request = end.event;

        // Opened BEFORE the wait so the harness is not deaf while a human
        // thinks: an event that arrives now — a session that died, above all —
        // settles the next segment instead of being dropped into a settled one.
        openSegment();
        const outcome = await Promise.race([
          askTheHuman(request).then((resolution) => ({ resolution })),
          turn.then((interrupted) => ({ interrupted })),
        ]);

        if ("interrupted" in outcome) {
          end = outcome.interrupted;
          break;
        }
        if (outcome.resolution.kind !== "answered") {
          end = { kind: "unanswered", reason: whyNoAnswer(outcome.resolution) };
          break;
        }
        log("a human answered a permission request", {
          run: work.runId,
          card: key.externalCardId,
          option: outcome.resolution.optionId,
        });
        await acp.answerPermission(agent.hubUserId, session.id, request.seq, outcome.resolution.optionId);
      }
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

    if (end.kind === "unanswered") {
      // **Failed, not blocked and not released.** A session started, so the
      // workspace may hold partial work — the same reasoning as `failStarted`.
      // `release` would hand a half-edited workspace to the next claimer with
      // nothing recording it; `block` would park the card AND cancel the
      // question, so the one thing a human could still usefully do disappears.
      // `fail` re-queues the card with the reason and a failure count, so the
      // question is asked again on the next attempt and superpipeline's circuit
      // breaker parks it for a human if nobody ever answers.
      //
      // Ending the session first also resolves the parked ACP request as
      // `cancelled`, which is the honest delivery of "no decision was made".
      const { reason } = end;
      await acp.endSession(agent.hubUserId, session.id, reason).catch(() => {});
      if (attemptId) await endAttempt(attemptId, "failed", lastSeq || null);
      try {
        await client.fail(work, reason);
      } catch (err) {
        if (isLeaseSuperseded(err) || isForeignRun(err)) {
          return await abort(deps, key, work, attemptId, err);
        }
        log("the board could not be told the question went unanswered", { run: work.runId, error: String(err) });
      }
      await afterTheBoardWasTold(deps, "the card was failed", () => markAbandoned(key, reason));
      log("a permission request went unanswered", { run: work.runId, card: key.externalCardId, reason });
      return { status: "unanswered", externalRunId: work.runId, attemptId: attemptId ?? undefined, reason };
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
      // A stale lease here may mean the agent completed the run itself a moment ago; `abort`
      // is where that is decided, for every path that reaches it.
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
    //
    // Swallowed whole: a throw in a `finally` REPLACES the value the try block
    // returned, so an unlucky measurement could discard the `foreign-run` that
    // is supposed to halt the loop. A note about the work never outranks it.
    await summarise(deps, key, work, attemptId, counts, coalescer.unmapped()).catch(() => {});
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
 * left it. superpipeline's `release` is the unpenalised verb for that (board-do.ts:
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
async function abort(
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

/**
 * Assemble the card into the versioned prompt contract.
 *
 * The context read is what makes this possible at all: `GET /runs/:runId`
 * returns the references and the card's `spec`, neither of which the claim
 * carries. The spike had no such endpoint and sent the title.
 *
 * Exported for its unit test; `workClaimed` is the only production caller.
 */
export async function assemblePrompt(
  deps: DispatchDeps,
  work: ClaimedWork,
  occupant: () => Promise<string | null>,
): Promise<CardPrompt> {
  // The board's switch is read once per claim, by whichever of the prefetch and the fetch asks first.
  let switchRead: Promise<boolean> | null = null;
  const enabled = (): Promise<boolean> => (switchRead ??= relatedWorkEnabled(deps.tenantId, deps.agent.boardId));
  // Gap S4: the agent's token is minted while the run context is read, so the related call finds it cached.
  try {
    (deps.prefetchRelated ?? prefetchRelatedWork)({ tenantId: deps.tenantId, boardId: deps.agent.boardId, cardId: work.card.id, principal: occupant, enabled });
  } catch {
    // Never part of the claim.
  }
  const ctx = await deps.client.context(work.runId);
  const cardId = ctx.card.id ?? work.card.id;
  // Never throws by contract; the catch is for a seam that does anyway, so the claim still goes ahead.
  const relatedWork = await (deps.relatedWork ?? fetchRelatedWork)({
    tenantId: deps.tenantId,
    boardId: deps.agent.boardId,
    cardId,
    principal: occupant,
    enabled,
  }).catch(() => undefined);
  return CardPrompt.parse({
    version: CARD_PROMPT_VERSION,
    source: deps.source,
    boardId: deps.agent.boardId,
    externalRunId: work.runId,
    card: {
      id: cardId,
      title: ctx.card.title ?? work.card.title,
      spec: ctx.card.spec,
    },
    stage: ctx.stage ?? work.stage,
    handoff: ctx.handoff ?? work.handoff,
    references: ctx.references ?? [],
    // attemptCount increments on CLAIM, so the agent working a card is always
    // on attempt 1 or later (RQ4).
    attempt: { number: ctx.card.attemptCount ?? work.card.attemptCount ?? 1 },
    // Told which run it holds ONLY when it has the tools to address it. A
    // prompt naming verbs the harness cannot call is an instruction to fail.
    run: boardTools(deps) ? { id: work.runId } : null,
    // Absent from a board that predates comments, and passed through as absent:
    // that is what keeps the prompt from naming comment tools such a board lacks.
    ...promptComments(ctx),
    // Passed whenever Superlibrary answered, an empty list included: "it answered and found nothing"
    // is not "it was not asked". The renderer shows no section for an empty list.
    ...(relatedWork !== undefined ? { relatedWork } : {}),
  });
}

/**
 * The card's comments, narrowed to what the prompt contract carries.
 *
 * The context is a cast, not a parse, so each comment is checked here: one malformed row is
 * dropped rather than failing `CardPrompt.parse` and with it the whole dispatch. A tombstone
 * (`deletedAt` set) is dropped too — its text is gone and an empty quote tells the agent nothing.
 */
function promptComments(ctx: RunContext): { comments?: CardPromptComment[]; commentsOmitted?: number } {
  if (!Array.isArray(ctx.comments)) return {};
  const comments: CardPromptComment[] = [];
  for (const c of ctx.comments as unknown[]) {
    if (c && typeof c === "object" && (c as { deletedAt?: unknown }).deletedAt) continue;
    const parsed = CardPromptComment.safeParse(c);
    if (parsed.success) comments.push(parsed.data);
  }
  const omitted = ctx.commentsOmitted;
  return {
    comments,
    commentsOmitted: typeof omitted === "number" && Number.isInteger(omitted) && omitted > 0 ? omitted : 0,
  };
}

/**
 * The board's own MCP server, as this agent's session should receive it — or
 * null when this agent has no run-scoped credential and therefore no tools.
 *
 * Built per dispatch and never stored. The `Bearer` is the agent's `mcpToken`,
 * which can drive a run and cannot claim one; the roster token, which can, is
 * the hub's alone and does not leave this process.
 */
function boardTools(deps: DispatchDeps): AcpMcpServer[] | null {
  const token = deps.agent.mcpToken;
  if (!token || !deps.mcpUrl) return null;
  return [
    {
      type: "http",
      name: SUPERPIPELINE_MCP_NAME,
      url: deps.mcpUrl,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
  ];
}

/**
 * What the harness will call its board tools: `superpipeline_complete`,
 * `superpipeline_get_run`. The card prompt names them in prose, so renaming
 * this renames them there too — and the prompt would then be wrong.
 */
const SUPERPIPELINE_MCP_NAME = "superpipeline";
