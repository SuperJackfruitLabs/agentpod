/**
 * An agent's question, turned into something a person can answer from a room.
 *
 * A gate asks a human to approve finished work. This asks a human to unblock a run that
 * has stopped mid-flight — which is what every permission prompt is. Until now the only
 * place to answer one was the board's web app, so an operator carrying the question
 * around in their pocket had to go and find a browser.
 *
 * The pure half: what the message says, what the card carries, and whether a body off
 * the wire is a question this build knows how to post. Projection, answering and the
 * sweep live elsewhere; keeping these here means every rule below can be tested without
 * a homeserver or a database.
 *
 * **The prose is the answerable surface; the card is the convenience.** A client that
 * has never heard of `dev.superpipeline.elicitation` still shows the prose, and a reply
 * of "2" still resolves, because answering matches an option's number, id or label
 * against the question this hub is holding for the room — never an event reference. So
 * this ships useful on day one and gets buttons whenever a client learns the key.
 */
import {
  ELICITATION_REQUEST_CONTENT_KEY,
  type ElicitationRequestCard,
} from "@agentpod/contract";

export { ELICITATION_REQUEST_CONTENT_KEY };

/** The body the board pushes on `elicitation.pending`. */
export interface ElicitationPendingDelivery {
  event: "elicitation.pending";
  boardId: string;
  /**
   * What the board is called. Optional because a board that has not shipped the field
   * sends none, and the room must keep the name it has rather than be renamed to
   * nothing — see `renameIfNeeded`.
   */
  boardName?: string | null;
  cardId: string;
  cardTitle: string;
  elicitationId: string;
  runId: string;
  stageKey: string;
  /** The agent that is waiting, and the one identity the board will not let answer. */
  agentId: string;
  /** The question. May be empty: an agent can stop on options alone. */
  question: string;
  options: Array<{ id: string; label: string }>;
  ts: string;
}

/**
 * How many options a client will draw as buttons.
 *
 * supermessage renders four and silently drops the rest (`DECISION_MAX_OPTIONS`), which
 * `PermissionRequestEvent` already documents. The cap is applied here, where the drop
 * can still be *reported* in the prose, rather than at the client where it can only be
 * lost.
 */
const MAX_BUTTONS = 4;

/**
 * Is this a question this hub knows how to post?
 *
 * The same reasoning as `isGatePending`, which says it best: "authenticated" is not
 * "checked". A board a version ahead, or behind, would otherwise have this hub posting a
 * question with no id to answer it by — which reads to the person in the room exactly
 * like a button that does nothing.
 *
 * `options` is required to be an array but may be EMPTY. A question with no options is a
 * real state and the reader needs it, because silence would otherwise mean both "no
 * question" and "a question you cannot tap".
 */
export function isElicitationPending(v: unknown): v is ElicitationPendingDelivery {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d.event === "elicitation.pending" &&
    typeof d.boardId === "string" &&
    typeof d.cardId === "string" &&
    typeof d.cardTitle === "string" &&
    typeof d.elicitationId === "string" &&
    d.elicitationId.length > 0 &&
    typeof d.runId === "string" &&
    typeof d.stageKey === "string" &&
    typeof d.agentId === "string" &&
    typeof d.question === "string" &&
    Array.isArray(d.options)
  );
}

/**
 * What the room is told.
 *
 * Every option is listed and numbered, however many there are, because the numbers are
 * what a typed reply is matched against — and this message is the only place a reader
 * learns that replying "1" works at all. When there are more options than buttons, the
 * message says so: somebody looking at four buttons and five lines of text needs to be
 * told the fifth is still answerable rather than left to assume it was dropped.
 *
 * A question with **no** options names the board instead. Answering here is by button or
 * by the option's number, decided deliberately, so there is nothing this hub can do with
 * a typed answer to an open question — and pretending otherwise would be worse than
 * sending the reader somewhere that works.
 */
export function elicitationProseBody(d: ElicitationPendingDelivery, link?: string): string {
  const tail = link ? ` [Open the card](${link})` : "";
  const asked = d.question.trim();
  const head = `An agent is waiting on you — "${d.cardTitle}" at stage \`${d.stageKey}\`.`;

  if (d.options.length === 0) {
    return [asked ? `${head}\n\n${asked}` : head, "", `Answer this one on the board.${tail}`].join(
      "\n",
    );
  }

  const numbered = d.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
  const capped =
    d.options.length > MAX_BUTTONS
      ? `\nOnly the first ${MAX_BUTTONS} have a button; the rest are answerable by number or name.`
      : "";
  return [
    asked ? `${head}\n\n${asked}` : head,
    "",
    numbered,
    "",
    `Reply with the number, or the option's name.${capped}${tail}`,
  ].join("\n");
}

/**
 * The question as it rides inside the prose message, under
 * `ELICITATION_REQUEST_CONTENT_KEY`.
 *
 * No `body`: the carrying message already has it, which is the choice the gate card made
 * for the same reason. `deep_link` is omitted rather than carried empty, so a reader
 * never has to tell "no link" apart from "a link to nowhere".
 */
export function elicitationRequestCard(
  d: ElicitationPendingDelivery,
  deepLink?: string,
): ElicitationRequestCard {
  return {
    schema_version: 1,
    board_id: d.boardId,
    card_id: d.cardId,
    elicitation_id: d.elicitationId,
    run_id: d.runId,
    stage_key: d.stageKey,
    card_title: d.cardTitle,
    asked_by: d.agentId,
    prompt: d.question,
    // The prose keeps all of them; only the buttons are capped.
    options: d.options.slice(0, MAX_BUTTONS),
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}
