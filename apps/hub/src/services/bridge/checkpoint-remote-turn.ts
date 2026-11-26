/**
 * A remote bench stage's ACP turn: the station's agent works in the card's bench, whose workspace
 * root is its working directory, through its own terminal and file tools.
 *
 * The session is the one an ordinary claim opens (`claimedSessionInput`: the board tools, the node's
 * MCP proxy, the run it works for), with the bench's working directory as its cwd. It is opened only
 * after the agent's node attached the station to the bench, because an open session keeps the
 * terminal backend it started with. "Done" is the end of the agent's turn: SuperPipeline refuses
 * `superpipeline_complete` on a checkpoint stage, so the agent ends its turn instead.
 *
 * As in ordinary dispatch:
 * - An `idle` with tool calls or detached Hermes work still in flight is not the end of the turn
 *   (`observeOwnWork`). Pending tool calls that settle get the same "continue" prompt; detached work
 *   is waited on until its wake goes quiet, within the agent's own-work limit.
 * - A permission request the hub did not answer itself under the roster's mode is asked on the
 *   board and waited on within the agent's permission limit; no answer ends the turn `unanswered`.
 */
import { CARD_PROMPT_VERSION, CardPrompt, CardPromptComment, renderCardPrompt, type AcpEvent } from "@agentpod/contract";
import { z } from "zod";
import { ActivityCoalescer, type BoardActivity } from "./coalesce";
import { DEFAULT_PERMISSION_WAIT_MS, type BridgeAgentConfig } from "./config";
import { boardTools, claimedSessionInput } from "./dispatch-prompt";
import { observeOwnWork, OWN_WORK_FINISHED_PROMPT, type OwnWork } from "./dispatch-turn";
import { DEFAULT_OWN_WORK_QUIET_MS, DEFAULT_OWN_WORK_TIMEOUT_MS, DEFAULT_PERMISSION_POLL_MS, SUMMARY_LIMIT,
  type AcpPort } from "./dispatch-types";
import { boardPermissionSubject, isAutoAnswered, selectedOptionId, withoutApprovals } from "./permission";
import { isEnvelopeRefusal, type RunElicitation, type SuperpipelineClient } from "./superpipeline";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { noteCheckpoint } from "./checkpoint-log";

/** Said before the card, word for word. */
export const REMOTE_TURN_PREFACE = "You are working in this card's workspace on a remote bench, through your terminal and file tools; " +
  "the workspace root is your working directory. Commit your work in the workspace's repositories and do not push. " +
  "End your turn when this stage's work is done.";

/** The board calls a remote turn makes: the run's context (its card and questions), the run check, and a question. */
export type RemoteTurnClient = Pick<SuperpipelineClient, "context" | "heartbeat" | "activity" | "runRecord">;

/**
 * The board's open and answered questions for exactly this run (GET runs/:id, read unvalidated). While a
 * question is open the board shows the run waiting on it, not `working`, so the checkpoint context check
 * refuses it; the questions are read here only for a view of this run and lease, still its card's run.
 */
const questionView = z.object({
  run: z.object({ runId: z.string(), leaseEpoch: z.number() }).passthrough(),
  card: z.object({ currentRunId: z.string().nullable() }).passthrough(),
  elicitations: z.array(z.object({ id: z.string(), status: z.enum(["pending", "answered", "cancelled"]),
    answer: z.object({ option: z.string().nullable().optional(), text: z.string().nullable().optional(), answeredBy: z.string(),
      answeredByPrincipal: z.string().nullable().optional(), answeredAt: z.string() }).nullable() }).passthrough()).optional(),
}).passthrough();
function runQuestions(raw: unknown, attempt: RetainedCheckpointAttempt): Array<Pick<RunElicitation, "id" | "status" | "answer">> {
  const view = questionView.safeParse(raw);
  if (!view.success || view.data.run.runId !== attempt.claim.runId || view.data.run.leaseEpoch !== attempt.claim.leaseEpoch ||
    view.data.card.currentRunId !== attempt.claim.runId) return [];
  return view.data.elicitations ?? [];
}

/** What a remote turn needs of the loop that runs its station: the ACP port and the roster row. */
export interface RemoteTurnDeps {
  acp: AcpPort;
  agent: BridgeAgentConfig;
  tenantId: string;
  /** SuperPipeline's MCP endpoint; with the agent's `mcpToken` it gives the session its board tools. */
  mcpUrl?: string;
  /** How often an open question's run is read again. Test seam; default as ordinary dispatch. */
  permissionPollMs?: number;
}

/**
 * How the turn ended. `end_turn`: the agent ended it. `error`: the turn failed (the hub recorded a
 * turn error). `ended`: the session ended under it. `cancelled`: the hub cancelled it. `timeout`:
 * its own work outlived the agent's limit. `unanswered`: a question it asked got no usable answer.
 */
export type RemoteStopReason = "end_turn" | "error" | "ended" | "cancelled" | "timeout" | "unanswered";
/** The handoff is the agent's to shape; the finish report sends each value as a string. */
export interface RemoteTurnEnd { stopReason: RemoteStopReason; handoff: Record<string, unknown> }

export interface RemoteTurn {
  readonly sessionId: string;
  /** The current turn's end. After `send`, the new turn's. */
  readonly done: Promise<RemoteTurnEnd>;
  /** Prompt the agent again in the same session. */
  send(prompt: string): Promise<void>;
  /** The session is open and its last turn did not fail. */
  alive(): boolean;
  /** End the session. */
  cancel(reason?: string): Promise<void>;
}

/** The card as the remote agent reads it: the run's context, with the board tools it holds. */
async function cardText(client: RemoteTurnClient, attempt: RetainedCheckpointAttempt, tools: boolean, libraryTools: boolean): Promise<string> {
  const context = await client.context(attempt.claim.runId, attempt.claim);
  return renderCardPrompt(CardPrompt.parse({ version: CARD_PROMPT_VERSION, source: "superpipeline",
    boardId: attempt.claim.boardId, externalRunId: attempt.claim.runId, card: context.card, stage: context.stage,
    handoff: context.handoff, references: context.references ?? [], attempt: { number: context.card.attemptCount ?? 1 },
    comments: (context.comments ?? []).map((comment) => CardPromptComment.parse(comment)),
    ...(context.commentsOmitted === undefined ? {} : { commentsOmitted: context.commentsOmitted }),
    run: tools ? { id: attempt.claim.runId } : null, libraryTools }));
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Open the session in `cwd` and prompt the agent with `opening` and the card. Resolves once the
 * prompt is sent; `done` resolves when the turn ends. A failure after the session opened ends it.
 */
export async function startRemoteTurn(deps: RemoteTurnDeps & { client: RemoteTurnClient }, attempt: RetainedCheckpointAttempt,
  cwd: string, opening = REMOTE_TURN_PREFACE): Promise<RemoteTurn> {
  const { acp, agent, client } = deps;
  const run = { source: "superpipeline" as const, id: attempt.claim.runId, epoch: attempt.claim.leaseEpoch };
  const session = await acp.createSession({ ...claimedSessionInput(deps, attempt.claim, () => client.heartbeat(attempt.claim)), cwd });
  let text: string;
  try { text = `${opening}\n\n${await cardText(client, attempt, boardTools(deps) !== null, session.libraryTools === true)}`; }
  catch (error) {
    await acp.endSession(agent.hubUserId, session.id, "The remote bench stage could not read its card.").catch(() => {}); // silent-catch-ok: the session is being abandoned; the error below says why
    throw error;
  }

  let ended = false;
  let failed = false;
  let segment = deferred();
  let said: string[] = [];
  let sawError = false;
  const own: OwnWork = { pendingToolCalls: new Set(), backgroundWork: new Map(), pendingBackgroundWork: new Set() };
  let waitingOnOwnWork = false;
  let waitingOnBackground = false;
  let wakeStarted = false;
  const seen = new Set<string>();
  const asked = new Set<string>();
  let ownWorkTimer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (ownWorkTimer) clearTimeout(ownWorkTimer);
    if (quietTimer) clearTimeout(quietTimer);
    ownWorkTimer = quietTimer = undefined;
  };
  const coalescer = new ActivityCoalescer();
  const collect = (activities: BoardActivity[]) => { for (const a of activities) if (a.type === "response" && a.body) said.push(a.body); };
  const handoff = (): Record<string, unknown> => {
    collect(coalescer.flush());
    const summary = said.join("").slice(0, SUMMARY_LIMIT);
    return { ...(summary ? { summary } : {}), station: agent.stationId, session: session.id };
  };
  const settle = (stopReason: RemoteStopReason) => {
    if (segment.settled) return;
    clearTimers();
    waitingOnOwnWork = waitingOnBackground = wakeStarted = false;
    failed = stopReason !== "end_turn";
    if (stopReason === "ended" || stopReason === "cancelled") ended = true;
    segment.resolve({ stopReason, handoff: handoff() });
  };
  const prompt = async (body: string) => {
    try { await acp.promptSession(agent.hubUserId, session.id, body, run); }
    catch { settle("error"); } // silent-catch-ok: a prompt the session refused ends the turn as `error`; the phase says so
  };
  const armQuiet = () => {
    if (!waitingOnBackground || !wakeStarted || own.pendingBackgroundWork.size > 0 || own.pendingToolCalls.size > 0) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (own.pendingBackgroundWork.size === 0 && own.pendingToolCalls.size === 0) settle("end_turn");
    }, agent.ownWorkQuietMs ?? DEFAULT_OWN_WORK_QUIET_MS);
  };
  const onIdle = () => {
    if (own.pendingToolCalls.size === 0 && own.pendingBackgroundWork.size === 0) return settle(sawError ? "error" : "end_turn");
    if (own.pendingBackgroundWork.size > 0) {
      // The agent yielded with detached work running: its wake, then quiet, is the end of the turn.
      waitingOnBackground = true;
      ownWorkTimer ??= setTimeout(() => settle("timeout"), agent.ownWorkTimeoutMs ?? DEFAULT_OWN_WORK_TIMEOUT_MS);
      return;
    }
    waitingOnOwnWork = true;
    ownWorkTimer ??= setTimeout(() => settle("timeout"), agent.ownWorkTimeoutMs ?? DEFAULT_OWN_WORK_TIMEOUT_MS);
  };
  const onUpdate = (update: object) => {
    const messageId = "messageId" in update && typeof update.messageId === "string" ? update.messageId : undefined;
    if (waitingOnBackground && (messageId ? !seen.has(messageId) : !wakeStarted)) {
      // A new message after the yield is the detached work's wake; it settles one unit of that work.
      if (messageId) seen.add(messageId);
      wakeStarted = true;
      const first = own.pendingBackgroundWork.values().next().value;
      if (typeof first === "string") own.pendingBackgroundWork.delete(first);
    } else if (messageId) seen.add(messageId);
    if (observeOwnWork(own, update) && waitingOnOwnWork && !waitingOnBackground && own.pendingToolCalls.size === 0) {
      waitingOnOwnWork = false;
      clearTimers();
      void prompt(OWN_WORK_FINISHED_PROMPT);
    }
    armQuiet();
  };
  /** A question that ends the turn `unanswered` says why in the checkpoint log (never its text). */
  const unanswered = (why: string, error?: unknown) => {
    noteCheckpoint("remote", `remote.question.${why}`, { attemptId: attempt.row.attemptId, runId: attempt.claim.runId }, error ?? new Error(why));
    settle("unanswered");
  };
  /** Ask on the board, as ordinary dispatch does, and deliver the answer; anything else ends the turn `unanswered`. */
  const ask = async (event: AcpEvent) => {
    for (const activity of coalescer.push(event)) {
      try { await client.activity(attempt.claim, activity); }
      catch (error) {
        const declineOnly = withoutApprovals(activity);
        if (!declineOnly || !isEnvelopeRefusal(error)) return unanswered("post", error);
        await client.activity(attempt.claim, declineOnly);
      }
    }
    const waitMs = agent.permissionWaitMs ?? DEFAULT_PERMISSION_WAIT_MS;
    const expiresAt = Date.parse(boardPermissionSubject(session.id, event.seq, event.payload, event.createdAt).expires_at);
    const deadline = Number.isFinite(expiresAt) ? Math.min(Date.now() + waitMs, expiresAt) : Date.now() + waitMs;
    const offered: unknown = typeof event.payload === "object" && event.payload !== null ? Reflect.get(event.payload, "options") : undefined;
    let questionId: string | undefined;
    for (;;) {
      if (segment.settled) return;
      const elicitations = runQuestions(await client.runRecord(attempt.claim.runId), attempt);
      const question = questionId ? elicitations.find((e) => e.id === questionId) : elicitations.filter((e) => !asked.has(e.id)).at(-1);
      if (!question || question.status === "cancelled") return unanswered(question ? "cancelled" : "unrecorded");
      questionId = question.id;
      asked.add(question.id);
      if (question.status === "answered") {
        const optionId = selectedOptionId(offered, question.answer);
        if (optionId === null) return unanswered("unmappable");
        const by = question.answer?.answeredBy;
        await acp.answerPermission(agent.hubUserId, session.id, event.seq, optionId,
          ...(by ? [{ via: "board" as const, principalId: question.answer?.answeredByPrincipal ?? null, userId: by }] : []));
        return;
      }
      if (Date.now() >= deadline) return unanswered("deadline");
      await sleep(deps.permissionPollMs ?? DEFAULT_PERMISSION_POLL_MS);
    }
  };
  const unsubscribe = acp.subscribe(session.id, (event: AcpEvent) => {
    const payload: unknown = event.payload;
    if (event.type === "agent-update") {
      collect(coalescer.push(event));
      if (typeof payload === "object" && payload !== null) onUpdate(payload);
      return;
    }
    if (event.type === "permission-request" && !isAutoAnswered(payload)) {
      void ask(event).catch((error: unknown) => unanswered("error", error));
      return;
    }
    if (event.type === "error") { sawError = true; return; }
    if (event.type !== "state") return;
    const status = typeof payload === "object" && payload !== null ? Reflect.get(payload, "status") : undefined;
    if (status === "ended") settle("ended");
    else if (status === "idle") onIdle();
  });
  await prompt(text);
  return {
    sessionId: session.id,
    get done() { return segment.promise; },
    async send(body) {
      if (ended) throw new Error("the remote session has ended");
      segment = deferred(); said = []; sawError = false; failed = false;
      await prompt(body);
    },
    alive: () => !ended && !failed,
    async cancel(reason = "The remote bench stage ended.") {
      unsubscribe();
      settle("cancelled");
      ended = true;
      await acp.endSession(agent.hubUserId, session.id, reason).catch(() => {}); // silent-catch-ok: a session already gone is ended
    },
  };
}

function deferred() {
  let resolve!: (value: RemoteTurnEnd) => void;
  const promise = new Promise<RemoteTurnEnd>((r) => { resolve = r; });
  const box = { promise, settled: false, resolve: (value: RemoteTurnEnd) => { box.settled = true; resolve(value); } };
  return box;
}
