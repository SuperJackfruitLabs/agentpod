/**
 * Putting an agent's question in a room, and taking the answer back.
 *
 * The I/O half; `elicitation-card.ts` holds the pure half. Structured as a near-mirror
 * of `gates.ts` on purpose: both are "a person must answer before this card moves",
 * both arrive by push with a sweep beneath them, and a reader who knows one should not
 * have to learn the other from scratch.
 *
 * Two places it deliberately differs from a gate, and both are worth knowing before
 * changing anything here:
 *
 * 1. **An answer does not reference the question's event.** A gate decision arrives as
 *    a structured event pointing at the message it answers. An elicitation answer is an
 *    ordinary room message — a number, an id or a label — matched against the question
 *    currently open in that room, exactly as an ACP permission answer is. That is what
 *    makes a question answerable from any Matrix client on the day this ships, instead
 *    of waiting for a client release.
 *
 * 2. **A question can be retired without being answered.** The board retires the
 *    previous question when an agent asks again, so a room can hold a card for
 *    something nobody can answer any more. A gate only stops being pending by being
 *    decided. The sweep is what notices, and it matters more here than there.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixElicitationEvents } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import {
  ELICITATION_REQUEST_CONTENT_KEY,
  elicitationProseBody,
  elicitationRequestCard,
  type ElicitationPendingDelivery,
} from "./elicitation-card";
import { matchPermissionAnswer, unmatchedAnswerText } from "./permissions";
import { IDENTITY_UNAVAILABLE_TEXT } from "../matrix-identity";
import { assertionFailureCode, type AssertionSubject } from "../../auth/org-plane/assertion";

const log = createLogger("matrix-elicitations");

export type ElicitationProjectionOutcome =
  | { status: "posted"; roomId: string; eventId: string }
  | { status: "already" }
  | { status: "no-room" }
  | { status: "not-accepted" };

export interface ElicitationProjectionDeps {
  /**
   * The board's room, made on first use.
   *
   * The same dependency the gate path takes, and the same reason it is the board's room
   * rather than the station's: a station room is spoken by an agent that owns its own
   * keys, so this hub must never encrypt as it and correctly refuses to decrypt for it.
   * A question posted there could be delivered and never answered — observed on
   * 2026-09-28 with a gate, and `charter →
   * decisions/2026-09-28-a-gate-belongs-to-its-board-not-to-an-agents-room.md` settled
   * it.
   */
  boardRoom(
    boardId: string,
    tenantId: string,
    opts?: { boardName?: string },
  ): Promise<{ roomId: string; speakerMxid: string } | null>;
  sendText(
    userId: string,
    roomId: string,
    body: string,
    extra?: Record<string, unknown>,
  ): Promise<string | null>;
  boardBaseUrl?: string;
  /** Marks an event as one this hub sent, so its own push does not echo back. */
  noteHubEvent?(eventId: string | null, kind: string): void;
}

/** Where the card's link goes. The same shape the gate link uses. */
function boardLink(baseUrl: string | undefined, boardId: string, cardId: string): string | undefined {
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/+$/, "")}/b/${encodeURIComponent(boardId)}/c/${encodeURIComponent(cardId)}`;
}

async function releaseClaim(elicitationId: string): Promise<void> {
  await db
    .delete(matrixElicitationEvents)
    .where(eq(matrixElicitationEvents.elicitationId, elicitationId));
}

/**
 * Post a question into its board's room, exactly once.
 *
 * The insert **is** the projection, not a record of one: `onConflictDoNothing` returning
 * no row means another delivery of the same question got here first, and this one stops
 * without posting. Doing it the other way round — send, then record — would post twice
 * under a redelivery and record once.
 *
 * A send that throws **gives the claim back**, which is the lesson `projectGate` paid
 * for: a claim held over a failed send leaves a row that every later pass reads as
 * "already handled", so the question becomes invisible on both sides — a person waiting
 * on an answer, and nothing anywhere reporting a fault. The cost of releasing is that a
 * question may be asked twice if the first send half-landed. A room that reads the
 * question twice is a cost; a question never asked is the failure this file exists to
 * prevent.
 *
 * The error is re-thrown rather than turned into an outcome, so the push receiver keeps
 * answering 5xx and the board keeps retrying. Converting it to a 200 would quietly
 * retire push's own retry and leave the sweep as the only path.
 */
export async function projectElicitation(
  tenantId: string,
  d: ElicitationPendingDelivery,
  deps: ElicitationProjectionDeps,
): Promise<ElicitationProjectionOutcome> {
  const found = await deps.boardRoom(d.boardId, tenantId, {
    ...(d.boardName ? { boardName: d.boardName } : {}),
  });
  if (!found) {
    log.warn("question has no board room to appear in", {
      elicitationId: d.elicitationId,
      cardId: d.cardId,
      boardId: d.boardId,
    });
    return { status: "no-room" };
  }

  const claimed = await db
    .insert(matrixElicitationEvents)
    .values({
      elicitationId: d.elicitationId,
      tenantId,
      boardId: d.boardId,
      cardId: d.cardId,
      roomId: found.roomId,
      // Replaced with the real id below. A row with a `pending:` event id means "being
      // sent", and every other reader treats it as taken — which is what stops a
      // concurrent delivery from asking the same question again.
      eventId: `pending:${d.elicitationId}`,
      optionsJson: JSON.stringify(d.options),
    })
    .onConflictDoNothing({ target: matrixElicitationEvents.elicitationId })
    .returning({ elicitationId: matrixElicitationEvents.elicitationId });
  if (claimed.length === 0) return { status: "already" };

  const deepLink = boardLink(deps.boardBaseUrl, d.boardId, d.cardId);

  let eventId: string | null;
  try {
    // One message, carrying the card inside it, for the reason the gate path gives: one
    // question is one event and one push — a push a phone can classify even in an
    // unencrypted room, where a custom event type matches no push rule.
    eventId = await deps.sendText(found.speakerMxid, found.roomId, elicitationProseBody(d, deepLink), {
      [ELICITATION_REQUEST_CONTENT_KEY]: elicitationRequestCard(d, deepLink),
    });
    deps.noteHubEvent?.(eventId, "elicitation");
  } catch (err) {
    await releaseClaim(d.elicitationId);
    log.warn("question could not be posted into its room; claim released so a later pass retries", {
      elicitationId: d.elicitationId,
      roomId: found.roomId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (!eventId) {
    // The claim has to go, or this question can never be projected again — the sweep
    // would see a row and conclude it had been handled.
    await releaseClaim(d.elicitationId);
    log.warn("question event was not accepted; claim released", {
      elicitationId: d.elicitationId,
      boardId: d.boardId,
      roomId: found.roomId,
    });
    return { status: "not-accepted" };
  }

  await db
    .update(matrixElicitationEvents)
    .set({ eventId })
    .where(eq(matrixElicitationEvents.elicitationId, d.elicitationId));

  log.info("question projected", {
    elicitationId: d.elicitationId,
    roomId: found.roomId,
    options: d.options.length,
  });
  return { status: "posted", roomId: found.roomId, eventId };
}

export interface OpenQuestion {
  elicitationId: string;
  boardId: string;
  cardId: string;
  roomId: string;
  options: Array<{ id: string; label: string }>;
}

/**
 * The question a room is currently waiting on, or null.
 *
 * A room holds at most one, because the board retires the previous question when the
 * same card's agent asks again — so "the open question in this room" is unambiguous and
 * a reply needs no event reference to find what it answers.
 *
 * A row still mid-send (`pending:…`) is **not** open. Its message is not in the room
 * yet, so nothing in the room could be a reply to it, and treating it as open would let
 * an unrelated message be read as an answer to a question nobody has seen.
 *
 * A row whose outcome has been posted is not open either: it has been answered, and the
 * room has already been told so.
 */
export async function openQuestionInRoom(roomId: string): Promise<OpenQuestion | null> {
  const rows = await db
    .select()
    .from(matrixElicitationEvents)
    .where(
      and(
        eq(matrixElicitationEvents.roomId, roomId),
        isNull(matrixElicitationEvents.outcomePostedAt),
      ),
    );
  const live = rows
    .filter((r) => !r.eventId.startsWith("pending:"))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!live) return null;
  let options: Array<{ id: string; label: string }> = [];
  try {
    options = JSON.parse(live.optionsJson) as Array<{ id: string; label: string }>;
  } catch {
    // A row we wrote ourselves, so this should not happen — but a question whose
    // options cannot be read is a question with no answerable options, which the
    // caller already handles, rather than a reason to throw on an inbound message.
    log.warn("question's options could not be read", { elicitationId: live.elicitationId });
  }
  return {
    elicitationId: live.elicitationId,
    boardId: live.boardId,
    cardId: live.cardId,
    roomId: live.roomId,
    options,
  };
}

/**
 * Claim the right to say in the room that the board took an answer.
 *
 * True exactly once per question. An answer delivered twice — a double tap, a re-sent
 * appservice transaction — must leave one line in the room rather than two that read as
 * though the question were answered twice.
 */
export async function claimElicitationOutcome(elicitationId: string): Promise<boolean> {
  const claimed = await db
    .update(matrixElicitationEvents)
    .set({ outcomePostedAt: new Date() })
    .where(
      and(
        eq(matrixElicitationEvents.elicitationId, elicitationId),
        isNull(matrixElicitationEvents.outcomePostedAt),
      ),
    )
    .returning({ elicitationId: matrixElicitationEvents.elicitationId });
  return claimed.length > 0;
}

/**
 * Hand an answer to the board, as the person who gave it.
 *
 * `principalId` must have come from `principal_identities` — the same rule
 * `resolveGateAtSuperpipeline` states, and the control that makes minting an assertion
 * for another principal safe to have at all.
 *
 * The board's answer route is session-authenticated by design, and the minted assertion
 * is what satisfies it. The board also refuses the ASKING agent by identity, which is
 * why this path can be trusted not to let an agent answer itself even though the hub is
 * now a second caller of that route.
 */
export async function answerElicitationAtSuperpipeline(
  input: {
    boardId: string;
    elicitationId: string;
    option: string;
    principalId: string;
    /** The Matrix sender, asserted by the org plane under it (contract §3.4b). */
    senderMxid: string;
  },
  deps: {
    baseUrl: string;
    mint(subject: AssertionSubject): Promise<string>;
    fetch?: typeof fetch;
  },
): Promise<{ ok: true } | { ok: false; code: string }> {
  let token: string;
  try {
    token = await deps.mint({ principalId: input.principalId, senderMxid: input.senderMxid });
  } catch (err) {
    // Refused or unreachable at the org plane: a failed outcome the room is told about, never a
    // token-less call to the board. Anything else throws, as it always has.
    const code = assertionFailureCode(err);
    if (!code) throw err;
    log.warn("no assertion for an answer", {
      elicitationId: input.elicitationId,
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code };
  }
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");

  let res: Response;
  try {
    res = await doFetch(
      `${base}/v1/boards/${encodeURIComponent(input.boardId)}/elicitations/${encodeURIComponent(input.elicitationId)}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ option: input.option }),
      },
    );
  } catch (err) {
    // The network, not a refusal. Distinguished because a refusal is final and this is
    // not — the reader should be able to answer again.
    log.warn("answer did not reach the board", {
      elicitationId: input.elicitationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNREACHABLE" };
  }

  if (res.ok) return { ok: true };

  // The board answers `{ error: { code } }`, and the code is what matters: a question
  // that is gone, one already answered, and an option that was never offered are three
  // different situations with the same shape.
  let code = `HTTP_${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    if (body.error?.code) code = body.error.code;
  } catch {
    // Keep the status-derived code.
  }
  return { ok: false, code };
}

/**
 * Questions this hub put in a room on a given board and has said nothing final about.
 *
 * The local half of the sweep. The table is the record of what we projected and
 * `outcome_posted_at IS NULL` the record of what we have not settled — neither of
 * which is knowable from the board, which is why this half reads here and the other
 * half reads there.
 *
 * Rows still mid-send (`pending:`) are excluded: nothing is in the room for them yet,
 * so there is nothing to settle and saying so would be answering a question nobody
 * has been asked.
 */
export async function postedElicitationsAwaitingOutcome(
  boardId: string,
): Promise<Array<{ elicitationId: string; roomId: string }>> {
  const rows = await db
    .select()
    .from(matrixElicitationEvents)
    .where(
      and(
        eq(matrixElicitationEvents.boardId, boardId),
        isNull(matrixElicitationEvents.outcomePostedAt),
      ),
    );
  return rows
    .filter((r) => !r.eventId.startsWith("pending:"))
    .map((r) => ({ elicitationId: r.elicitationId, roomId: r.roomId }));
}

/** What a reply in a board room turned out to be. */
export type ElicitationAnswerOutcome =
  | { status: "answered"; elicitationId: string }
  | { status: "not-an-answer" }
  | { status: "no-question" }
  | { status: "unmatched" }
  | { status: "refused"; code: string };

export interface ElicitationAnswerDeps {
  principalForMatrixId(mxid: string): Promise<{ id: string; kind: string } | null>;
  answer(input: {
    boardId: string;
    elicitationId: string;
    option: string;
    principalId: string;
    senderMxid: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** Say something back in the room. */
  reply(roomId: string, body: string): Promise<unknown>;
  /** True exactly once per question — see `claimElicitationOutcome`. */
  claimOutcome(elicitationId: string): Promise<boolean>;
}

/**
 * A plain message in a board room, read as an answer to the question open there.
 *
 * Returns `no-question` when the room has nothing open, which is the common case: most
 * messages in a board room are not answers, and this must be cheap and silent for them.
 * It says nothing in the room in that case — a board room is not a chat with the hub,
 * and replying "there is no question" to ordinary conversation would be noise.
 *
 * An **unmatched** reply gets the options back rather than a scolding, reusing
 * `unmatchedAnswerText`. That distinction matters: a person who typed "yes" at a
 * question offering "run_them" needs to see what is on offer, not to be told they were
 * wrong.
 */
export async function handleElicitationAnswer(
  event: { sender: string; body: string },
  roomId: string,
  deps: ElicitationAnswerDeps,
): Promise<ElicitationAnswerOutcome> {
  const open = await openQuestionInRoom(roomId);
  if (!open) return { status: "no-question" };
  if (open.options.length === 0) {
    // Buttons-only, by decision: there is nothing this hub can do with a typed answer
    // to an open question. The prose already said to answer it on the board.
    return { status: "not-an-answer" };
  }

  const matched = matchPermissionAnswer(
    event.body,
    open.options.map((o) => ({ optionId: o.id, name: o.label })),
  );
  if (!matched) {
    await deps.reply(roomId, unmatchedAnswerText(open.options.map((o) => ({ optionId: o.id, name: o.label }))));
    return { status: "unmatched" };
  }

  let identity: Awaited<ReturnType<ElicitationAnswerDeps["principalForMatrixId"]>>;
  try {
    identity = await deps.principalForMatrixId(event.sender);
  } catch (error) {
    // The org plane could not say who this is and nothing was cached (design §5.7). Refused,
    // and said, because "down" is not "unknown" and the question stays open for a retry.
    log.warn("could not resolve an answer's sender", {
      roomId,
      sender: event.sender,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.reply(roomId, IDENTITY_UNAVAILABLE_TEXT);
    return { status: "refused", code: "IDENTITY_UNAVAILABLE" };
  }
  if (!identity) {
    // Unknown and ambiguous are refused as firmly as each other: guessing would
    // attribute an answer to somebody who did not give it, and an answer's whole value
    // is the record of who gave it.
    log.warn("answer from a sender this hub cannot resolve", { roomId, sender: event.sender });
    return { status: "refused", code: "UNRESOLVED_SENDER" };
  }

  const result = await deps.answer({
    boardId: open.boardId,
    elicitationId: open.elicitationId,
    option: matched,
    principalId: identity.id,
    senderMxid: event.sender,
  });

  if (!result.ok) {
    if (result.code === "ELICITATION_NOT_PENDING" || result.code === "ELICITATION_NOT_FOUND") {
      // Answered on the board, or retired by a newer question. Said once, under the
      // same claim a successful answer uses, so a double tap leaves one line.
      if (await deps.claimOutcome(open.elicitationId)) {
        await deps.reply(roomId, "That one is already settled — the board has it.");
      }
      return { status: "refused", code: result.code };
    }
    await deps.reply(
      roomId,
      result.code === "IDENTITY_UNAVAILABLE"
        ? IDENTITY_UNAVAILABLE_TEXT
        : `That did not go through (${result.code}). Nothing has changed.`,
    );
    return { status: "refused", code: result.code };
  }

  if (await deps.claimOutcome(open.elicitationId)) {
    const chosen = open.options.find((o) => o.id === matched);
    await deps.reply(roomId, `Answered: ${chosen?.label ?? matched}. The agent is unblocked.`);
  }
  return { status: "answered", elicitationId: open.elicitationId };
}
