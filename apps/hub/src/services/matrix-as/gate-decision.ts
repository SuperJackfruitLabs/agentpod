/**
 * The way back: a human's answer in the room becomes a resolution at superpipeline, and the
 * receipt that says the board accepted it.
 *
 * Split out of `gates.ts`, which re-exports it.
 */

import { createLogger } from "../../utils/logger";
import { IDENTITY_UNAVAILABLE_TEXT } from "../matrix";
import { GATE_DECISION_SUITE_TYPE, GATE_OUTCOME_TYPE, isGateOptionId, type GateOptionId } from "./gate-wire";

const log = createLogger("matrix-gates");

/** Why a decision event was not acted on. Every value is a refusal. */
export type DecisionRefusal =
  | "not-a-decision"
  | "unlinked-sender"
  /**
   * The org plane could not be asked who the sender is, and nothing was cached (design §5.7's
   * one named online dependency). Not "unlinked": the sender may well be linked.
   */
  | "identity-unavailable"
  /** The org plane refused to assert the sender (contract §3.4b), or asserted somebody else. */
  | "assertion-refused"
  /** A linked principal that is not a person — an agent or a service. */
  | "not-human"
  | "unknown-gate"
  | "reference-mismatch"
  | "bad-option";

export interface GateDecisionEvent {
  sender: string;
  content: Record<string, unknown>;
}

export interface ParsedGateDecision {
  gateId: string;
  optionId: GateOptionId;
  comment: string | null;
  referencedEventId: string | null;
}

/**
 * Read a decision out of an `m.room.message`, or refuse.
 *
 * The event is an ordinary message carrying `suite_event_type` in content, not
 * a custom type — a decision needs no renderer, so sending it as a message
 * means it reads in every client and a reader never sees their own answer twice.
 *
 * `m.relates_to` must be an **`m.reference`**. `m.in_reply_to` is a rendering
 * hint every client sets when quoting, so accepting it would let an ordinary
 * quoted reply resolve a gate.
 */
export function parseGateDecision(content: unknown): ParsedGateDecision | null {
  if (typeof content !== "object" || content === null) return null;
  const c = content as Record<string, unknown>;
  if (c.suite_event_type !== GATE_DECISION_SUITE_TYPE) return null;
  if (typeof c.gate_id !== "string" || c.gate_id.length === 0) return null;
  if (!isGateOptionId(c.option_id)) return null;

  const rel = c["m.relates_to"];
  let referencedEventId: string | null = null;
  if (typeof rel === "object" && rel !== null) {
    const r = rel as Record<string, unknown>;
    if (r.rel_type === "m.reference" && typeof r.event_id === "string") {
      referencedEventId = r.event_id;
    }
  }

  return {
    gateId: c.gate_id,
    optionId: c.option_id,
    comment: typeof c.comment === "string" && c.comment.trim() !== "" ? c.comment : null,
    referencedEventId,
  };
}

export interface GateDecisionDeps {
  /**
   * The principal a Matrix id belongs to, or null when nobody has linked it.
   *
   * `principal_identities` — the record of sameness minted by an explicit link,
   * never inferred from a localpart or a matching email.
   */
  /**
   * The principal a Matrix id belongs to **and what kind of thing it is**, or null
   * when nobody has linked it.
   *
   * `principal_identities` — the record of sameness minted by an explicit link,
   * never inferred from a localpart or a matching email.
   *
   * The kind is returned rather than looked up separately so a caller cannot
   * resolve a gate without having been handed the answer to "is this a person?".
   * Agents are linked here too (`prn_… | matrix | @agent_guild_hermes-cleaner-cody`),
   * and superpipeline refuses an agent resolving its OWN gate while having no reason
   * to refuse a different one (agentpod#608).
   */
  principalForMatrixId(
    mxid: string,
  ): Promise<{ id: string; kind: "human" | "agent" | "service" } | null>;
  /** The recorded projection for a gate, or null if this hub never posted it. */
  projectionFor(gateId: string): Promise<{
    tenantId: string;
    boardId: string;
    eventId: string;
    /** The prose message carrying the gate, when it was recorded. */
    proseEventId?: string | null;
  } | null>;
  /**
   * Resolve the gate at superpipeline **as `principalId`**, never as this service.
   *
   * The whole decision of 2026-08-14 rests here: a bridge that substituted its
   * own identity would make every approval in the suite attribute to one
   * account and void superpipeline's separation-of-duties check.
   */
  resolveGate(input: {
    tenantId: string;
    boardId: string;
    gateId: string;
    decision: GateOptionId;
    comment: string | null;
    principalId: string;
    /**
     * The Matrix sender. Under the org plane the plane asserts this identity and resolves the
     * human itself (contract §3.4b); `principalId` is what the hub resolved, checked against it.
     */
    senderMxid: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** Say something back in the room. Used when a gate was already resolved. */
  reply(roomId: string, body: string): Promise<unknown>;
  /**
   * Post the structured half of a receipt beside its prose.
   *
   * Two events rather than one, the same convention the gate itself uses and for
   * the same reason: a stock Matrix client renders an unknown *event type* as
   * nothing at all, so prose is what a reader outside supermessage is left with.
   */
  sendOutcome?(roomId: string, content: Record<string, unknown>): Promise<unknown>;
  /** How to name the person who answered, for the receipt. Their handle, not an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  /** Remember that a receipt was posted, so a repeated decision cannot post a second. */
  markOutcomePosted?(gateId: string): Promise<boolean>;
}

/** What superpipeline's refusal of a decision becomes: the reason, and what is said in the room. */
async function refusalForCode(
  code: string,
  gateId: string,
  sender: string,
  roomId: string,
  deps: Pick<GateDecisionDeps, "reply">
): Promise<{ status: "refused"; reason: DecisionRefusal }> {
  if (code === "GATE_NOT_PENDING") {
    // Answered on the board, or a double tap on a slow connection. Not
    // swallowed: the person who tapped is owed the reason nothing happened.
    await deps.reply(roomId, "That was already decided — the board has it.");
    return { status: "refused", reason: "unknown-gate" };
  }

  // The assertion could not be had (only under the org plane): a failed receipt, said in the room,
  // because the person who tapped is owed the reason nothing happened and can tap again.
  if (code === "IDENTITY_UNAVAILABLE") {
    log.warn("gate decision not carried: the org plane is unreachable", { gateId });
    await deps.reply(roomId, IDENTITY_UNAVAILABLE_TEXT);
    return { status: "refused", reason: "identity-unavailable" };
  }
  if (code === "ASSERTION_REFUSED" || code === "ASSERTION_MISMATCH") {
    log.warn("gate decision not carried: the org plane would not assert the sender", {
      gateId,
      sender,
      code,
    });
    await deps.reply(
      roomId,
      `That did not go through (${code}): the account service would not vouch for you. Nothing has changed.`,
    );
    return { status: "refused", reason: "assertion-refused" };
  }

  log.warn("superpipeline refused a decision", { gateId, code });
  return { status: "refused", reason: "unknown-gate" };
}

/**
 * Act on a human's answer, or refuse and say why.
 *
 * Every branch that is not "resolved" leaves the gate untouched. That is the
 * point: this is the only path in the suite where a message from a room becomes
 * authority somewhere else, so it fails closed at every step.
 */
export async function handleGateDecision(
  event: GateDecisionEvent,
  roomId: string,
  deps: GateDecisionDeps
): Promise<{ status: "resolved" } | { status: "refused"; reason: DecisionRefusal }> {
  const parsed = parseGateDecision(event.content);
  if (!parsed) return { status: "refused", reason: "not-a-decision" };

  const projection = await deps.projectionFor(parsed.gateId);
  if (!projection) {
    log.warn("decision names a gate this hub never posted", { gateId: parsed.gateId });
    return { status: "refused", reason: "unknown-gate" };
  }

  // Both identifiers are carried so they can be checked against each other.
  // Trusting the reference alone would mean resolving whatever gate an
  // untrusted sender pointed at; trusting `gate_id` alone would let a sender
  // name a gate they never saw.
  //
  // Either of the gate's two events may be the one referenced: a client that
  // draws the legacy custom event answers that, one that draws the key inside
  // the prose answers the prose. Both were posted by this hub for this gate.
  const referenced = parsed.referencedEventId;
  const matches =
    referenced !== null &&
    (referenced === projection.eventId || (!!projection.proseEventId && referenced === projection.proseEventId));
  if (!matches) {
    log.warn("decision's reference and gate disagree", {
      gateId: parsed.gateId,
      referenced: parsed.referencedEventId,
    });
    return { status: "refused", reason: "reference-mismatch" };
  }

  let principal: Awaited<ReturnType<GateDecisionDeps["principalForMatrixId"]>>;
  try {
    principal = await deps.principalForMatrixId(event.sender);
  } catch (error) {
    // The one plane call design §5.7 allows. Down is not "unlinked": say which, in the room,
    // because a person who tapped Approve and saw nothing would tap again or give up.
    log.warn("could not resolve a gate decision's sender", {
      sender: event.sender,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.reply(roomId, IDENTITY_UNAVAILABLE_TEXT);
    return { status: "refused", reason: "identity-unavailable" };
  }
  if (!principal) {
    // An unlinked Matrix user in a room is a case this must handle explicitly
    // (charter decisions/2026-08-13-ecosystem-identity.md, Decision 2). It is
    // not an error — someone may simply be in the room — so it is logged and
    // dropped rather than answered.
    log.info("decision from an unlinked sender, ignored", { sender: event.sender });
    return { status: "refused", reason: "unlinked-sender" };
  }

  /**
   * A gate is a human's answer, and until now nothing said so.
   *
   * The check above asks whether the sender is linked, not whether they are a
   * person. Agents are linked. superpipeline enforces separation of duties —
   * `decidedBy !== producedBy` — so it refuses an agent resolving its own gate and
   * has no reason to refuse a different one. An agent emitting a decision event in
   * a room this hub can read would therefore approve another agent's gate: a human
   * approval gate satisfied by a machine, which is the one property a gate exists
   * to have.
   *
   * Dormant only because the hub cannot decrypt in harness-mode rooms, so no
   * decision of any kind is processed there. The board room that makes a human's
   * answer readable makes an agent's readable too, which is why this lands with it
   * rather than after it (charter →
   * `decisions/2026-09-28-a-gate-belongs-to-its-board-not-to-an-agents-room.md`).
   *
   * Warned rather than dropped quietly: an agent trying to answer a gate is worth
   * somebody seeing.
   */
  if (principal.kind !== "human") {
    log.warn("a non-human principal tried to answer a gate", {
      sender: event.sender,
      principalId: principal.id,
      kind: principal.kind,
      gateId: parsed.gateId,
    });
    return { status: "refused", reason: "not-human" };
  }

  const result = await deps.resolveGate({
    tenantId: projection.tenantId,
    boardId: projection.boardId,
    gateId: parsed.gateId,
    decision: parsed.optionId,
    comment: parsed.comment,
    principalId: principal.id,
    senderMxid: event.sender,
  });

  if (result.ok) {
    await postOutcomeReceipt(roomId, parsed, principal.id, projection, deps);
    return { status: "resolved" };
  }

  return refusalForCode(result.code, parsed.gateId, event.sender, roomId, deps);
}

/**
 * Say in the room that the board accepted an answer.
 *
 * Best-effort on purpose. The gate IS resolved by the time this runs — superpipeline
 * has it — so a receipt that cannot be posted must not turn a successful approval
 * into a failure the caller reports. What it costs is a room that reads as though
 * nothing happened, which is the defect this fixes, not one it can re-create.
 *
 * Posted once. `markOutcomePosted` claims the gate before sending, so a decision
 * delivered twice — a double tap, a re-sent transaction — leaves one receipt rather
 * than two contradictory-looking ones.
 */
async function postOutcomeReceipt(
  roomId: string,
  parsed: ParsedGateDecision,
  principalId: string,
  projection: { boardId: string; eventId: string; proseEventId?: string | null },
  deps: GateDecisionDeps,
): Promise<void> {
  await settleGateOutcome(
    { gateId: parsed.gateId, decision: parsed.optionId, decidedBy: principalId },
    roomId,
    projection,
    deps,
  );
}

/**
 * Post the receipt that takes a decided gate out of contention, and claim it.
 *
 * Shared by the two ways a gate stops being pending. One is a decision arriving as a Matrix event
 * — supermessage — which is what this was written for. The other is a decision made anywhere
 * else: superpipeline's own web UI resolves the gate directly, this hub never hears, and the room
 * card goes on offering Approve and Reject **forever**. Observed live on 2026-09-29: a gate
 * approved on the web at 12:20 still showing live buttons twenty-five minutes later, beside the
 * next gate for the same card.
 *
 * `markOutcomePosted` claims before sending, so the Matrix path and the sweep racing on the same
 * gate leave one receipt rather than two.
 */
export async function settleGateOutcome(
  decided: { gateId: string; decision: string; decidedBy: string | null },
  roomId: string,
  projection: { boardId: string; eventId: string; proseEventId?: string | null },
  deps: Pick<GateDecisionDeps, "markOutcomePosted" | "displayNameFor" | "reply" | "sendOutcome">,
): Promise<void> {
  const parsed = { gateId: decided.gateId, optionId: decided.decision } as ParsedGateDecision;
  const principalId = decided.decidedBy;
  try {
    if (deps.markOutcomePosted && !(await deps.markOutcomePosted(parsed.gateId))) return;

    const who = principalId ? ((await deps.displayNameFor?.(principalId)) ?? null) : null;
    const verb = OUTCOME_VERBS[parsed.optionId] ?? parsed.optionId;
    const body = who ? `${verb} by ${who} — the board has it.` : `${verb} — the board has it.`;

    await deps.reply(roomId, body);

    // The gate's own event is what a card is drawn from, so the receipt points at it
    // rather than at the prose: a client that finds this knows which card to close.
    await deps.sendOutcome?.(roomId, {
      suite_event_type: GATE_OUTCOME_TYPE,
      gate_id: parsed.gateId,
      board_id: projection.boardId,
      decision: parsed.optionId,
      decided_by: who,
      "m.relates_to": { rel_type: "m.reference", event_id: projection.eventId },
    });
  } catch (err) {
    log.warn("gate resolved but its receipt could not be posted", {
      gateId: parsed.gateId,
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** How each decision reads in a sentence. Falls back to the option id. */
const OUTCOME_VERBS: Record<string, string> = {
  approve: "Approved",
  // An approval gate bound to a publishing subject offers these two instead of `approve`; they
  // read as the raw key ("approve_automatic by …") until they were named here.
  approve_automatic: "Approved for automatic delivery",
  approve_manual: "Approved for manual delivery",
  reject: "Rejected",
  request_changes: "Changes requested",
};
