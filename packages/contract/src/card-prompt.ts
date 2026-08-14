import { z } from "zod";

import { AcpRunId } from "./ids";

/**
 * The prompt contract: what a board's card becomes when it is handed to a
 * harness.
 *
 * This is the actual contract between the two planes, and until now nothing
 * wrote it down. The bridge spike sent `work.card.title` as the entire prompt
 * (`apps/bridge/spike/src/bridge.ts`) — the spec, the previous stage's handoff
 * and every reference were dropped, and a harness given only a title does the
 * wrong work confidently. No test caught it, because every test asserted the
 * seam *carried* the work rather than what the work said.
 *
 * The three inputs are exactly what an agent token may read. kaambaan's
 * `GET /v1/boards/:boardId/runs/:runId` returns `{run, card, stage, handoff,
 * references}` and nothing else, so this shape is the whole agent-visible
 * surface projected into text.
 *
 * It is **versioned** because changing how a card reads changes what agents do.
 * A renderer that silently gains a section changes every run on every board;
 * a version in the shape makes that a decision someone takes rather than a
 * diff someone lands. `CardPrompt` refuses a version it cannot render — a
 * `card-prompt/2` parsed as v1 is how a section goes missing on one side of a
 * seam and nobody notices.
 *
 * The rendered text — not just the shape — is pinned by
 * `fixtures/ecosystem-identity/card_prompt.json`, so a peer repo that assembles
 * a card differently fails its own test suite rather than in an agent's
 * behaviour.
 */
export const CARD_PROMPT_VERSION = "card-prompt/1";

/** A card reference as an agent may read it (kaambaan `ReferenceView`, narrowed). */
export const CardPromptReference = z.object({
  url: z.string().min(1),
  /** kaambaan's references are nullable-titled; a URL alone still renders. */
  title: z.string().nullable().default(null),
  provider: z.string().min(1),
  sourceType: z.string().min(1),
});
export type CardPromptReference = z.infer<typeof CardPromptReference>;

const CardPrompt_ = z.object({
  /** Refused when unknown: an unrenderable version must not render as v1. */
  version: z.literal(CARD_PROMPT_VERSION),

  /**
   * Which orchestrator this card came from. Open, like `Run.externalSource`,
   * so the hub is not kaambaan-only — and required, because a prompt built
   * from work whose orchestrator is unnamed cannot be traced to the board that
   * asked for it.
   */
  source: z.string().min(1),
  boardId: z.string().min(1),
  /** The orchestrator's work run id — never one of AgentPod's own attempt ids. */
  externalRunId: z.string().min(1),

  card: z.object({
    id: z.string().min(1),
    /**
     * Always rendered, and the harness's whole instruction when there is no
     * spec. An empty one produces a prompt that asks for nothing and gets a
     * confident answer anyway.
     */
    title: z.string().min(1),
    /** kaambaan's `JsonValue` spec. Absent is normal; a title-only card is legal. */
    spec: z.unknown().optional(),
  }),

  /** null when the board's stage list no longer contains the card's stage. */
  stage: z.object({ key: z.string().min(1), name: z.string().min(1) }).nullable().default(null),

  /** The previous stage's handoff, verbatim. `feedback` is lifted out on render. */
  handoff: z.unknown().optional(),

  references: z.array(CardPromptReference).default([]),

  attempt: z.object({
    /**
     * kaambaan's `attemptCount`, which increments on **claim** (spike RQ4), so
     * the agent working a card is always on attempt 1 or later. A zero means
     * the count was read from the wrong field, and "attempt 0" invites a
     * harness to treat a retry as a first run.
     */
    number: z.number().int().positive(),
  }),
});

export const CardPrompt = CardPrompt_.refine(
  (p) => !AcpRunId.safeParse(p.externalRunId).success,
  {
    // The same rule `Run.externalRunId` carries, applied where the id enters
    // rather than where it is stored: an `attempt_…` here means AgentPod's own
    // key was passed off as the board's work run.
    message:
      "externalRunId must not be one of AgentPod's own attempt ids — a card prompt is built for an orchestrator's run",
    path: ["externalRunId"],
  },
);
export type CardPrompt = z.infer<typeof CardPrompt>;

// ─── Rendering ───────────────────────────────────────────────────────────────

/** A string stays a string; anything else is fenced JSON, never `[object Object]`. */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when a handoff carries nothing worth a section of its own. */
function isEmptyHandoff(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

function referenceLine(r: CardPromptReference): string {
  const suffix = `${r.url} (${r.provider}/${r.sourceType})`;
  return r.title ? `- ${r.title} — ${suffix}` : `- ${suffix}`;
}

/**
 * Assemble the prompt. Deterministic: section order never depends on the data,
 * and an absent section is omitted entirely rather than rendered empty — a
 * heading with nothing under it reads to a harness as "there was nothing to do
 * here", which is a different claim from "this was not provided".
 *
 * Nothing here is a credential, a lease epoch or an AgentPod id. The text
 * crosses into a harness process and can be echoed back into a transcript the
 * board renders, so it carries only what the harness can act on.
 */
export function renderCardPrompt(prompt: CardPrompt): string {
  const blocks: string[] = [`# ${prompt.card.title.trim()}`];

  const provenance = [
    `${prompt.source} board ${prompt.boardId}`,
    `card ${prompt.card.id}`,
    ...(prompt.stage ? [`stage ${prompt.stage.name} (${prompt.stage.key})`] : []),
    // Attempt 2 of a card is not the same instruction as attempt 1, and a
    // harness that cannot tell them apart cannot behave differently on a retry.
    `attempt ${prompt.attempt.number}`,
  ];
  blocks.push(`${provenance.join(" · ")}.`);

  if (prompt.card.spec !== undefined && prompt.card.spec !== null) {
    blocks.push(`## Task\n\n${renderValue(prompt.card.spec)}`);
  }

  // A `request_changes` gate decision merges `{feedback}` into the handoff the
  // agent itself produced and re-queues the card (kaambaan board-do.ts:1505).
  // Left inside the blob, the reviewer's instruction sits below the agent's own
  // summary of what it already did — the most important sentence on the card,
  // rendered as the least prominent one.
  let handoff = prompt.handoff;
  if (isPlainObject(handoff) && typeof handoff.feedback === "string" && handoff.feedback.trim()) {
    const { feedback, ...rest } = handoff;
    blocks.push(`## Review feedback\n\n${feedback.trim()}`);
    handoff = rest;
  }

  if (!isEmptyHandoff(handoff)) {
    blocks.push(`## Handoff from the previous stage\n\n${renderValue(handoff)}`);
  }

  if (prompt.references.length > 0) {
    blocks.push(`## References\n\n${prompt.references.map(referenceLine).join("\n")}`);
  }

  // The bridge owns reporting. A harness that tries to drive the board itself
  // has no credential for it, and one that asks for more work would keep a
  // lease open past the card it was claimed for.
  blocks.push(
    "## Completing this card\n\nDo the work in this workspace, then stop. Your progress is reported to the board for you — do not call the board, and do not ask for the next card.",
  );

  return blocks.join("\n\n");
}
