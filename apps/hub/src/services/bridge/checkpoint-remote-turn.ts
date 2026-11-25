/**
 * A remote bench stage's ACP turn: the station's agent works in the card's bench, whose workspace
 * root is its working directory, through its own terminal and file tools.
 *
 * The session is the one an ordinary claim opens (`claimedSessionInput`: the board tools, the node's
 * MCP proxy, the run it works for), with the bench's working directory as its cwd. It is opened only
 * after the agent's node attached the station to the bench, because an open session keeps the
 * terminal backend it started with. "Done" is the end of the agent's turn: SuperPipeline refuses
 * `superpipeline_complete` on a checkpoint stage, so the agent ends its turn instead.
 */
import { CARD_PROMPT_VERSION, CardPrompt, CardPromptComment, renderCardPrompt, type AcpEvent } from "@agentpod/contract";
import { ActivityCoalescer } from "./coalesce";
import { boardTools, claimedSessionInput } from "./dispatch-prompt";
import { SUMMARY_LIMIT, type AcpPort } from "./dispatch-types";
import type { BridgeAgentConfig } from "./config";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import type { SuperpipelineClient } from "./superpipeline";

/** Said before the card, word for word. */
export const REMOTE_TURN_PREFACE = "You are working in this card's workspace on a remote bench, through your terminal and file tools; " +
  "the workspace root is your working directory. Commit your work in the workspace's repositories and do not push. " +
  "End your turn when this stage's work is done.";

/** The board calls a remote turn makes: the card's run context, and the session's run check. */
export type RemoteTurnClient = Pick<SuperpipelineClient, "context" | "heartbeat">;

/** What a remote turn needs of the loop that runs its station: the ACP port and the roster row. */
export interface RemoteTurnDeps {
  acp: AcpPort;
  agent: BridgeAgentConfig;
  tenantId: string;
  /** SuperPipeline's MCP endpoint; with the agent's `mcpToken` it gives the session its board tools. */
  mcpUrl?: string;
}

/**
 * How the turn ended. `end_turn`: the agent ended it. `error`: the turn failed (the hub recorded a
 * turn error). `ended`: the session ended under it. `cancelled`: the hub cancelled it.
 */
export type RemoteStopReason = "end_turn" | "error" | "ended" | "cancelled";
/** The handoff is the agent's to shape; the finish report sends each value as a string. */
export interface RemoteTurnEnd { stopReason: RemoteStopReason; handoff: Record<string, unknown> }

export interface RemoteTurn {
  readonly sessionId: string;
  /** The current turn's end. After `send`, the new turn's. */
  readonly done: Promise<RemoteTurnEnd>;
  /** Prompt the agent again in the same session (a dirty tree to commit). */
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

/**
 * Open the session in `cwd` and prompt the agent with the preface and the card. Resolves once the
 * prompt is sent; `done` resolves when the turn ends.
 */
export async function startRemoteTurn(deps: RemoteTurnDeps & { client: RemoteTurnClient }, attempt: RetainedCheckpointAttempt,
  cwd: string, preface = REMOTE_TURN_PREFACE): Promise<RemoteTurn> {
  const { acp, agent, client } = deps;
  const run = { source: "superpipeline" as const, id: attempt.claim.runId, epoch: attempt.claim.leaseEpoch };
  const session = await acp.createSession({ ...claimedSessionInput(deps, attempt.claim, () => client.heartbeat(attempt.claim)), cwd });
  const text = `${preface}\n\n${await cardText(client, attempt, boardTools(deps) !== null, session.libraryTools === true)}`;

  let ended = false;
  let failed = false;
  let segment = deferred();
  let said: string[] = [];
  let sawError = false;
  const coalescer = new ActivityCoalescer();
  const handoff = (): Record<string, unknown> => {
    for (const a of coalescer.flush()) if (a.type === "response" && a.body) said.push(a.body);
    const summary = said.join("").slice(0, SUMMARY_LIMIT);
    return { ...(summary ? { summary } : {}), station: agent.stationId, session: session.id };
  };
  const settle = (stopReason: RemoteStopReason) => {
    if (segment.settled) return;
    failed = stopReason !== "end_turn";
    if (stopReason === "ended" || stopReason === "cancelled") ended = true;
    segment.resolve({ stopReason, handoff: handoff() });
  };
  const unsubscribe = acp.subscribe(session.id, (event: AcpEvent) => {
    if (event.type === "agent-update") {
      for (const a of coalescer.push(event)) if (a.type === "response" && a.body) said.push(a.body);
      return;
    }
    if (event.type === "error") { sawError = true; return; }
    if (event.type !== "state") return;
    const payload: unknown = event.payload;
    const status = typeof payload === "object" && payload !== null ? Reflect.get(payload, "status") : undefined;
    if (status === "ended") settle("ended");
    else if (status === "idle") settle(sawError ? "error" : "end_turn");
  });
  const prompt = async (body: string) => {
    try { await acp.promptSession(agent.hubUserId, session.id, body, run); }
    catch { settle("error"); } // silent-catch-ok: a prompt the session refused ends the turn as `error`; the phase says so
  };
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
