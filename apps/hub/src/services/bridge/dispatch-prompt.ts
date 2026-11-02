/**
 * The card prompt a dispatch sends, and the board tools a session is given. Split out of
 * dispatch.ts, unchanged.
 */

import { CARD_PROMPT_VERSION, CardPrompt, CardPromptComment, type AcpMcpServer } from "@agentpod/contract";
import { fetchRelatedWork, prefetchRelatedWork, relatedBasis, relatedWorkEnabled } from "../superlibrary";
import type { DispatchDeps } from "./dispatch-types";
import type { ClaimedWork, RunContext } from "./superpipeline";

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
    text: relatedBasis(ctx.card.title ?? work.card.title, ctx.card.spec),
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
export function boardTools(deps: DispatchDeps): AcpMcpServer[] | null {
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
