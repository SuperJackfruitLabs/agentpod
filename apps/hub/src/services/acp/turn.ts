/** One turn: dispatching the prompt, and how its response or rejection settles the session. */

import { sql } from "drizzle-orm";
import { SalaamAcpFailure, SalaamPromptReceipt } from "@agentpod/contract";
import type { SalaamRunAuthority, TurnError } from "@agentpod/contract";
import { acpTraceMeta } from "../../telemetry/propagation";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { recordAudit } from "../audit";
import * as broker from "../broker";
import { connectionManager } from "../broker";
import { promptBlocks, type PromptImage } from "../matrix";
import { getSalaamPrompt, inspectSalaamExecution, updateSalaamPrompt } from "../salaam";
import { SESSION_BUSY_MESSAGE } from "./busy";
import { persistEvent, setStatus } from "./events";
import { nodeReadsLargeFrames } from "./gates";
import { log } from "./log";
import { awaitTurnError } from "./plugin-reports";
import { deriveSessionTitle } from "./rows";
import { renewExecution } from "./salaam-authority";
import { requireLive, type LiveSession } from "./session-state";
import {
  gatewayUnreachable,
  rejectionSaidNothing,
  turnErrorForSilentTurn,
  turnErrorForUnreachableGateway,
  turnErrorFromReason,
  turnErrorFromRejection,
} from "./turn-error";

/** What a turn calls back up into: the re-attach a lost gateway triggers (`recovery.ts`). */
export interface TurnDeps {
  reattachAfterTransportLoss(live: LiveSession): Promise<void>;
}

type AuditHandle = Awaited<ReturnType<typeof recordAudit>>;
type ParsedFailure = ReturnType<typeof SalaamAcpFailure.safeParse>;

/** One dispatched turn, as its response and rejection handlers see it. */
interface Turn {
  live: LiveSession;
  deps: TurnDeps;
  audit: AuditHandle;
  epoch: number;
  logicalRequestId: string;
  /** Only the completion of the CURRENT turn may transition status. */
  isCurrentTurn(): boolean;
  /** The turn is over: clear the in-flight marks (a no-op once a newer turn began). */
  settled(): void;
  /** Record the turn's error and put the session back where it can be prompted. */
  recordError(error: TurnError): Promise<void>;
}

export async function dispatchPrompt(
  deps: TurnDeps,
  userId: string,
  sessionId: string,
  text: string,
  images: PromptImage[] = [],
  executionRun?: SalaamRunAuthority,
  requestId?: string,
): Promise<void> {
  const live = requireLive(userId, sessionId);
  if (live.executionAuthority)
    await renewExecution(userId, sessionId, executionRun);
  if (live.status !== "idle") {
    throw new Error(SESSION_BUSY_MESSAGE);
  }
  const agent = live.agent;
  if (!agent) throw new Error("Session is still starting.");

  const logicalRequestId = requestId ?? crypto.randomUUID();
  await writePrompt(live, text, images, logicalRequestId);
  const audit = await auditPrompt(live, userId, text, images);

  if (live.executionAuthority)
    await updateSalaamPrompt(live.id, logicalRequestId, "dispatched");
  live.logicalPromptInFlight = logicalRequestId;

  const imageRefusal = await imageRefusalFor(live, images);
  const turn = beginTurn(live, deps, audit, logicalRequestId);

  // The turn runs in the background; its completion restores idle. Callers
  // observe progress via subscribe()/acp_events, not this promise.
  agent
    .request("session/prompt", {
      sessionId: live.acpSessionId,
      prompt: promptBlocks(text, images, imageRefusal),
      ...acpTraceMeta(),
      ...(live.executionAuthority
        ? {
            _meta: {
              ...((acpTraceMeta() as { _meta?: object })._meta ?? {}),
              "salaam.dev/requestId": logicalRequestId,
            },
          }
        : {}),
    })
    .then((response) => onTurnResponse(turn, response))
    .catch((err) => onTurnRejected(turn, err));
}

/**
 * The user-prompt event and the `working` state, written together.
 *
 * The first real prompt names the session, in the user-prompt's own write.
 * COALESCE is what makes "first" mean first: an existing title always wins,
 * so a long conversation keeps the label the user recognises no matter how
 * many prompts follow (and a whitespace-only prompt sets nothing at all).
 */
async function writePrompt(
  live: LiveSession,
  text: string,
  images: PromptImage[],
  logicalRequestId: string,
): Promise<void> {
  const title = deriveSessionTitle(text || images[0]?.name || "");
  const { done: promptWritten } = persistEvent(
    live,
    "user-prompt",
    images.length === 0
      ? {
          text,
          ...(live.executionAuthority ? { requestId: logicalRequestId } : {}),
        }
      : {
          text,
          images: images.map(({ name, mimeType, bytes }) => ({
            name,
            mimeType,
            bytes,
          })),
        },
    title === null
      ? {}
      : { title: sql`COALESCE(${acpSessions.title}, ${title})` },
  );
  const { done: statusWritten } = setStatus(live, "working");
  await Promise.all([promptWritten, statusWritten]);
}

/**
 * Audit the action, never the prompt text. An audit failure must not strand
 * the session at `working`: revert to idle with an error event and rethrow.
 */
async function auditPrompt(
  live: LiveSession,
  userId: string,
  text: string,
  images: PromptImage[],
): Promise<AuditHandle> {
  try {
    return await recordAudit(db, {
      tenantId: live.tenantId,
      userId,
      nodeId: live.nodeId,
      stationKey: live.stationKey,
      verb: "acp.prompt",
      params:
        images.length === 0
          ? { chars: text.length }
          : { chars: text.length, images: images.length },
    });
  } catch (err) {
    persistEvent(
      live,
      "error",
      turnErrorFromReason(
        "Couldn't record the audit entry — prompt aborted.",
        live.harness,
        "hub",
      ),
    );
    await setStatus(live, "idle").done;
    throw err;
  }
}

/**
 * Whether this turn's images can travel. Two things must be true: the agent
 * said at `initialize` that it takes images, and its node reads frames that
 * large. A node from before "frames.large" closes its whole hub connection
 * on any frame over 32 KiB — every station on it, mid-turn — which is what
 * the first image sent to Krishna did (ashram, 2026-09-24).
 */
async function imageRefusalFor(live: LiveSession, images: PromptImage[]): Promise<string | null> {
  let imageRefusal: string | null = null;
  if (images.length > 0) {
    if (!live.acceptsImages) {
      imageRefusal = "this agent cannot view images";
    } else if (!(await nodeReadsLargeFrames(live.nodeId))) {
      imageRefusal =
        "this agent's machine needs an AgentPod update before it can receive images";
    }
  }
  return imageRefusal;
}

/** Reset the per-turn marks and take this turn's epoch (the stale-turn guard). */
function beginTurn(
  live: LiveSession,
  deps: TurnDeps,
  audit: AuditHandle,
  logicalRequestId: string,
): Turn {
  // Stale-turn guard: only the completion of the CURRENT turn may transition
  // status (a late response from a cancelled turn must not reset a new one).
  live.turnEpoch += 1;
  live.turnProduced = false;
  live.turnInFlight = true;
  live.turnErrorRecorded = false;
  live.turnErrorSource = null;
  live.pendingTurnError = null;
  live.pendingTurnErrorAt = 0;
  live.lastProducedAt = 0;
  live.turnResolution = null;
  const epoch = live.turnEpoch;
  return {
    live,
    deps,
    audit,
    epoch,
    logicalRequestId,
    isCurrentTurn: () =>
      !live.ended &&
      live.turnEpoch === epoch &&
      (live.status === "working" ||
        (live.status === "waiting" &&
          live.pendingCancellation?.targetRequestId === logicalRequestId)),
    settled: () => {
      if (live.turnEpoch !== epoch) return;
      live.turnInFlight = false;
      if (live.logicalPromptInFlight === logicalRequestId)
        delete live.logicalPromptInFlight;
      live.lastTurnSettledAt = Date.now();
    },
    recordError: async (error: TurnError) => {
      if (live.executionAuthority)
        error = {
          ...error,
          failureCode: error.failureCode ?? "execution_interrupted",
          logicalRequestId: logicalRequestId,
          localSessionId: live.executionAuthority.sessionId ?? undefined,
        };
      live.turnErrorRecorded = true;
      live.turnErrorSource = error.source;
      await audit.done("error", error.message).catch(() => {});
      const { done: errorWritten } = persistEvent(live, "error", error);
      const { done: idleWritten } = setStatus(
        live,
        live.pendingCancellation && live.pendingCancellation.state !== "confirmed"
          ? "waiting"
          : "idle",
      );
      await Promise.all([errorWritten, idleWritten]);
    },
  };
}

// ─── The response ─────────────────────────────────────────────────────────────

async function onTurnResponse(turn: Turn, response: unknown): Promise<void> {
  const { live } = turn;
  const parsedFailure = await checkSalaamResponse(turn, response);
  const stopReason = (response as { stopReason?: unknown })?.stopReason;
  if (
    parsedFailure?.success ||
    ["max_tokens", "refusal", "cancelled"].includes(String(stopReason)) ||
    (live.executionAuthority && stopReason !== "end_turn")
  ) {
    const error = parsedFailure?.success
      ? turnErrorFromRejection(
          { data: { "salaam.dev/failure": parsedFailure.data } },
          live.harness,
        )
      : turnErrorForSilentTurn(live.harness, stopReason);
    if (turn.isCurrentTurn()) await turn.recordError(error);
    else await turn.audit.done("error", error.message);
    turn.settled();
    return;
  }
  if (!turn.isCurrentTurn()) {
    await turn.audit.done("ok");
    turn.settled();
    return;
  }
  await settleCurrentTurn(turn, response);
}

/**
 * A Salaam response's typed failure, checked against this instruction, and its terminal receipt
 * recorded. Throws (into the rejection handler) on metadata that is malformed or not this turn's.
 */
async function checkSalaamResponse(turn: Turn, response: unknown): Promise<ParsedFailure | null> {
  const { live, logicalRequestId } = turn;
  const responseMeta = (response as { _meta?: Record<string, unknown> })
    ._meta;
  const rawFailure = responseMeta?.["salaam.dev/failure"];
  const parsedFailure = rawFailure
    ? SalaamAcpFailure.safeParse(rawFailure)
    : null;
  if (rawFailure && !parsedFailure?.success)
    throw Error("Salaam returned malformed typed failure metadata");
  if (
    parsedFailure?.success &&
    (parsedFailure.data.requestId !== logicalRequestId ||
      parsedFailure.data.sessionId !== live.executionAuthority?.sessionId)
  )
    throw Error("Salaam failure belongs to another instruction");
  if (live.executionAuthority) {
    const metadata = (response as { _meta?: Record<string, unknown> })
      ._meta;
    const terminal = SalaamPromptReceipt.parse({
      sessionId: live.id,
      requestId: metadata?.["salaam.dev/requestId"],
      attemptId: metadata?.["salaam.dev/attemptId"],
      state:
        (response as { stopReason?: string }).stopReason === "end_turn" &&
        !parsedFailure?.success
          ? "completed"
          : "interrupted",
    });
    if (terminal.requestId !== logicalRequestId || !terminal.attemptId)
      throw Error(
        "Salaam returned a receipt for a different logical instruction",
      );
    await updateSalaamPrompt(
      live.id,
      logicalRequestId,
      terminal.state,
      terminal.attemptId,
    );
  }
  return parsedFailure;
}

/** The current turn ended normally: its plugin's report, a silent turn, or an answer. */
async function settleCurrentTurn(turn: Turn, response: unknown): Promise<void> {
  const { live } = turn;
  // A plugin already said why, during the turn — unless the agent spoke
  // after that report. OpenClaw's plugin reports a failed model once its
  // attempts go quiet, and the next model in the chain can still answer
  // (krishna, 2026-09-26 08:09: Kimi's quota, then a fallback's "Hey
  // Rakesh"). Words after the report mean the chain recovered; a report
  // after the last words (a partial answer, or Pi reporting at settled
  // after "Retrying…") is the turn's error.
  if (
    live.pendingTurnError &&
    live.lastProducedAt > live.pendingTurnErrorAt
  ) {
    log.info(
      "a plugin's turn error was followed by an answer; the fallback recovered",
      {
        sessionId: live.id,
        kind: live.pendingTurnError.kind,
      },
    );
    live.pendingTurnError = null;
  }
  if (live.pendingTurnError) {
    await turn.recordError(live.pendingTurnError);
    turn.settled();
    return;
  }
  if (!live.turnProduced) {
    await settleSilentTurn(turn, response);
    return;
  }
  await turn.audit.done("ok");
  await setStatus(live, "idle").done;
  turn.settled();
}

/**
 * Nothing came back. A harness that drops its errors over ACP may
 * have a plugin about to say why; give it a moment — unless its
 * plugin has already said the run ended well.
 */
async function settleSilentTurn(turn: Turn, response: unknown): Promise<void> {
  const { live } = turn;
  const reported = live.turnResolution ?? (await awaitTurnError(live));
  if (!turn.isCurrentTurn()) {
    turn.settled();
    return;
  }
  if (reported === "answered" || reported === "silent") {
    // The agent chose to say nothing (NO_REPLY). An empty turn it
    // chose is not a failed one: no error, and the room says done.
    await turn.audit.done("ok");
    await setStatus(live, "idle", { extra: { silent: true } }).done;
    turn.settled();
    return;
  }
  await turn.recordError(
    reported ??
      turnErrorForSilentTurn(
        live.harness,
        (response as { stopReason?: unknown } | undefined)?.stopReason,
      ),
  );
  turn.settled();
}

// ─── The rejection ────────────────────────────────────────────────────────────

async function onTurnRejected(turn: Turn, err: unknown): Promise<void> {
  const { live, logicalRequestId } = turn;
  const typed = SalaamAcpFailure.safeParse(
    (err as { data?: Record<string, unknown> })?.data?.[
      "salaam.dev/failure"
    ],
  );
  const correlated =
    typed.success &&
    typed.data.sessionId === live.executionAuthority?.sessionId &&
    typed.data.requestId === logicalRequestId;
  if (live.executionAuthority)
    await updateSalaamPrompt(
      live.id,
      logicalRequestId,
      correlated ? "interrupted" : "unknown",
      correlated ? typed.data.attemptId : undefined,
    ).catch(() => {});
  if (await awaitDaemonOutcome(turn)) return;
  // The harness's words, with what it put in `data` — Codex's quota
  // sentence is only there — classified into one shape for every reader.
  let error = turnErrorFromRejection(err, live.harness);
  if (live.executionAuthority)
    error =
      typed.success && !correlated
        ? {
            message:
              "Salaam returned failure metadata for another instruction",
            kind: "unknown",
            harness: "salaam",
            source: "acp-rejection",
            failureCode: "failure_correlation",
            logicalRequestId,
            localSessionId: live.executionAuthority.sessionId ?? undefined,
          }
        : {
            ...error,
            failureCode: error.failureCode ?? "execution_interrupted",
            logicalRequestId,
            localSessionId: live.executionAuthority.sessionId ?? undefined,
          };
  error = await probeSilentRejection(turn, err, error);
  await turn.audit.done("error", error.message).catch(() => {});
  // Wire-level failures transition the session via handleWireClosed; only
  // recover to idle when this turn is still the live one. A normal ACP
  // request rejection is different: persist it in the transcript so every
  // client sees the provider or adapter error instead of an idle empty turn.
  if (turn.isCurrentTurn()) {
    // A plugin's report knows the provider and the fallback chain; the
    // rejection, when both exist, is the less specific of the two.
    const recorded = live.pendingTurnError ?? error;
    live.turnErrorRecorded = true;
    live.turnErrorSource = recorded.source;
    const { done: errorWritten } = persistEvent(live, "error", recorded);
    const { done: idleWritten } = setStatus(
      live,
      live.pendingCancellation &&
        live.pendingCancellation.state !== "confirmed"
        ? "waiting"
        : "idle",
    );
    await Promise.all([errorWritten, idleWritten]);
    turn.settled();
    return;
  }
  // A node that dropped rejects its prompt at once, while the session
  // waits at `waiting` for it to come back. That turn is not over — it is
  // lost, and finalizeEnd records why if the node never returns.
  if (!live.ended && live.turnEpoch === turn.epoch && live.status === "waiting")
    return;
  turn.settled();
}

/**
 * A Salaam prompt rejected because its transport went away: the accepted prompt belongs to the
 * daemon, so inspect it (for up to 90 s) and never resubmit it. True when that settled the turn.
 */
async function awaitDaemonOutcome(turn: Turn): Promise<boolean> {
  const { live, logicalRequestId } = turn;
  if (
    !(
      live.executionAuthority &&
      !live.ended &&
      (live.transportLost || !connectionManager.isOnline(live.nodeId))
    )
  )
    return false;
  // The accepted prompt belongs to the daemon. Inspect it; never resubmit it.
  const deadline = Date.now() + 90_000;
  while (!live.ended && Date.now() < deadline) {
    if (connectionManager.isOnline(live.nodeId)) {
      try {
        const status = await inspectSalaamExecution(
          live.executionAuthority,
        );
        if (status.revoked) break;
        if (status.interrupted_attempts.length) {
          await turn.recordError(
            turnErrorFromReason(
              "Salaam attempt interrupted; explicit continuation required",
              "salaam",
              "hub",
            ),
          );
          turn.settled();
          return true;
        }
        if (!status.active_attempts.length) {
          const recovered = await getSalaamPrompt(
            live.userId,
            live.id,
            logicalRequestId,
          );
          if (["completed", "interrupted"].includes(recovered.state)) {
            await turn.audit.done(
              recovered.state === "completed" ? "ok" : "error",
              recovered.state === "completed"
                ? undefined
                : "Saved instruction was interrupted or cancelled",
            );
            await setStatus(
              live,
              live.pendingCancellation &&
                live.pendingCancellation.state !== "confirmed"
                ? "waiting"
                : "idle",
            ).done;
            turn.settled();
            return true;
          }
          // Absence of an active process alone is not a terminal outcome.
        }
      } catch {
        // The daemon could not be inspected this time; poll again until the deadline.
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * …and when the harness gave us no words at all, go and find out why.
 *
 * A bare JSON-RPC generic is not a failure any amount of text matching can
 * classify. It is also exactly what a harness sends when the thing it talks
 * THROUGH has gone away but its own process has not: observed on 2026-10-03,
 * when an agent restarted the OpenClaw gateway hosting its own session and
 * three prompts in a row came back as "Internal error". `pgrep` said the
 * gateway was running the whole time, so nothing short of a dial could tell.
 *
 * One question, only when we learned nothing, and only an explicit "not
 * reachable" is allowed to replace the harness's own error — see
 * `gatewayUnreachable` for why the asymmetry matters.
 */
async function probeSilentRejection(turn: Turn, err: unknown, error: TurnError): Promise<TurnError> {
  const { live } = turn;
  if (rejectionSaidNothing(err)) {
    const probe = await broker.request(live.nodeId, "acp.transport", {
      key: live.stationKey,
    });
    if (probe.ok && gatewayUnreachable(probe.data)) {
      const unreachable = turnErrorForUnreachableGateway(live.harness);
      // Background, deliberately: the reader already has their answer, and the
      // session quietly becomes usable again behind it.
      void turn.deps.reattachAfterTransportLoss(live);
      return unreachable;
    }
  }
  return error;
}
