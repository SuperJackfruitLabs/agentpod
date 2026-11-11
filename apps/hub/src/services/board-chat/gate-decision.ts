/**
 * The way back: a human's answer in the room becomes a resolution at superpipeline, and the
 * receipt that says the board accepted it.
 *
 * Split out of `gates.ts`, which re-exports it.
 */

import type { MatrixGateQuorum, MatrixGateVariant } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import { IDENTITY_UNAVAILABLE_TEXT } from "../matrix";
import {
  GATE_DECISION_SUITE_TYPE,
  GATE_DECISION_V2_SUITE_TYPE,
  GATE_OUTCOME_TYPE,
  isGateOptionId,
  heldTail,
  heldUntilOf,
} from "@superjackfruitlabs/treaty-matrix-events";

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
  /** gate.v2: an option this hub did not record as offered for that gate. */
  | "bad-option"
  /** gate.v2: an option that needs a comment arrived without one. */
  | "comment-required"
  /** gate.v2: an answer to a subject-bound gate that does not say which subject it approves. */
  | "subject-missing"
  /** gate.v2: an approving answer to a subject gate whose preview was not shown in full. */
  | "preview-incomplete"
  /** A variant gate: an approving answer whose binding names none of the gate's variants. */
  | "variant-unknown"
  /** A variant gate: the chosen variant's preview was not shown in full here. */
  | "variant-incomplete"
  /** A variant gate: the chosen variant's subject has passed its expiry. */
  | "variant-expired"
  /** superpipeline: the binding names no subject of the gate, or one no longer active. */
  | "subject-mismatch"
  /** superpipeline: the approved subject has expired. */
  | "subject-expired"
  /** superpipeline: a quorum gate this person has already approved (`QUORUM_ALREADY_APPROVED`). */
  | "quorum-already-approved"
  /** superpipeline: on a quorum gate, this person's approval does not count (`APPROVAL_DECIDER_NOT_ALLOWED`). */
  | "decider-not-allowed"
  /** superpipeline: the approval would be released after its subject expires (`APPROVAL_RELEASE_AFTER_EXPIRY`). */
  | "release-after-expiry";

export interface GateDecisionEvent {
  sender: string;
  content: Record<string, unknown>;
}

/** The subject an answer says it was shown: copied from the gate.v2 the person saw. */
export interface GateSubjectBinding {
  id: string;
  digest: string;
}

export interface ParsedGateDecision {
  /** Which answer type it arrived as: `decision.v1` or `decision.v2`. */
  version: 1 | 2;
  gateId: string;
  /**
   * For v1, one of the three v1 ids. For v2, whatever the client sent: this hub keeps no list,
   * and `handleGateDecision` checks it against the options recorded for that gate.
   */
  optionId: string;
  comment: string | null;
  referencedEventId: string | null;
  /** v2 only, and null when absent or malformed. */
  subject: GateSubjectBinding | null;
}

/** The subject binding a decision.v2 carries, or null when there is none to read. */
function subjectBinding(v: unknown): GateSubjectBinding | null {
  if (typeof v !== "object" || v === null) return null;
  if (!("id" in v) || !("digest" in v)) return null;
  const { id, digest } = v;
  if (typeof id !== "string" || id.length === 0 || typeof digest !== "string" || digest.length === 0) {
    return null;
  }
  return { id, digest };
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
  const version = c.suite_event_type === GATE_DECISION_SUITE_TYPE ? 1 : c.suite_event_type === GATE_DECISION_V2_SUITE_TYPE ? 2 : null;
  if (version === null) return null;
  if (typeof c.gate_id !== "string" || c.gate_id.length === 0) return null;
  // v1 keeps its three ids. v2 keeps no list (charter gate.v2 §2): any non-empty id is read,
  // and checked against what the gate offered once the gate is known.
  const optionId = c.option_id;
  if (typeof optionId !== "string" || optionId.length === 0) return null;
  if (version === 1 && !isGateOptionId(optionId)) return null;

  const rel = c["m.relates_to"];
  let referencedEventId: string | null = null;
  if (typeof rel === "object" && rel !== null) {
    const r = rel as Record<string, unknown>;
    if (r.rel_type === "m.reference" && typeof r.event_id === "string") {
      referencedEventId = r.event_id;
    }
  }

  return {
    version,
    gateId: c.gate_id,
    optionId,
    comment: typeof c.comment === "string" && c.comment.trim() !== "" ? c.comment : null,
    referencedEventId,
    subject: version === 2 ? subjectBinding(c.subject) : null,
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
    /**
     * What the gate offered when it was projected (gate.v2). Null for a gate projected before
     * this hub recorded options — a decision.v2 on one is refused, since nothing says what it
     * offered; a decision.v1 is unaffected.
     */
    options?: ReadonlyArray<{ id: string; meaning: string; needs_comment: boolean }> | null;
    /** The subject a subject-bound gate approves; null when it is bound to none. */
    subjectId?: string | null;
    /** Whether the subject's preview was carried in full; false refuses an approving answer. */
    subjectPreviewComplete?: boolean | null;
    /** A variant gate's variants as projected (charter 2026-11-09); null when it is not a choice. */
    variants?: ReadonlyArray<MatrixGateVariant> | null;
    /**
     * A quorum gate's quorum as last recorded (charter 2026-11-09, more than one approver); null
     * when the gate passes on one approval. Present: an accepted approval is not taken as the gate
     * passing until `readGate` says it is resolved.
     */
    quorum?: MatrixGateQuorum | null;
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
    decision: string;
    comment: string | null;
    principalId: string;
    /**
     * The Matrix sender. Under the org plane the plane asserts this identity and resolves the
     * human itself (contract §3.4b); `principalId` is what the hub resolved, checked against it.
     */
    senderMxid: string;
    /** gate.v2: the subject the person was shown, for superpipeline to match against its own. */
    approvalSubject?: GateSubjectBinding;
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
  /**
   * The board's read of a gate (`GET …/gates/:gateId`), or null when it cannot be read. Asked only
   * after an approval of a quorum gate was accepted, because accepted is not passed: an approval
   * short of the quorum leaves the gate pending. Absent or failing: the gate sweep settles it.
   */
  readGate?(
    boardId: string,
    gateId: string,
  ): Promise<{
    status: string;
    decision: string | null;
    decidedBy: string | null;
    chosen?: { id: string; label: string } | null;
    /** A held approval's release time (charter 2026-11-09, an approval may wait), named in the receipt. */
    heldUntil?: string | null;
  } | null>;
}

/**
 * Why a decision.v2 must not be carried, or null when it may.
 *
 * Checked against what THIS gate offered when it was projected — never a fixed list. This is
 * the carrier refusing what it can already see is wrong; superpipeline remains the judge and
 * refuses again on its own terms (an id not offered, a binding that does not match).
 */
function v2Refusal(
  parsed: ParsedGateDecision,
  projection: NonNullable<Awaited<ReturnType<GateDecisionDeps["projectionFor"]>>>,
): { reason: DecisionRefusal; text: string } | null {
  const option = projection.options?.find((o) => o.id === parsed.optionId);
  if (!option) {
    return { reason: "bad-option", text: "That is not one of this gate's options. Nothing has changed." };
  }
  if (option.needs_comment && !parsed.comment) {
    return { reason: "comment-required", text: "That answer needs a comment. Nothing has changed." };
  }
  if (projection.variants) return variantRefusal(parsed, option, projection.variants);
  if (projection.subjectId && !parsed.subject) {
    return {
      reason: "subject-missing",
      text: "That answer did not say which version it approves. Nothing has changed.",
    };
  }
  // The card could not show everything being approved, so an approval of it is refused here —
  // a client should not have offered one (charter gate.v2 §3). Request changes and reject stay.
  if (projection.subjectId && option.meaning === "approve" && projection.subjectPreviewComplete !== true) {
    return {
      reason: "preview-incomplete",
      text: "The card could not show everything being approved, so it cannot be approved from here. Open the card on the board. Nothing has changed.",
    };
  }
  return null;
}

/** The variant an answer's binding names exactly, by subject id and digest, if any. */
function chosenVariant(
  binding: GateSubjectBinding | null,
  variants: ReadonlyArray<MatrixGateVariant> | null | undefined,
): MatrixGateVariant | null {
  if (!binding || !variants) return null;
  return variants.find((v) => v.subject_id === binding.id && v.digest === binding.digest) ?? null;
}

/** Has this expiry passed? An expiry that cannot be read is not taken as passed: the board judges. */
function expired(expiresAt: string | null, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * Why an answer to a variant gate must not be carried (charter 2026-11-09 §2, §4). An approval is
 * the choice: its binding must name exactly one recorded variant, whose preview reached the room in
 * full and whose subject has not expired. Request changes and reject act on the whole set and need
 * no binding.
 */
function variantRefusal(
  parsed: ParsedGateDecision,
  option: { meaning: string },
  variants: ReadonlyArray<MatrixGateVariant>,
): { reason: DecisionRefusal; text: string } | null {
  if (option.meaning !== "approve") return null;
  if (!parsed.subject) {
    return { reason: "subject-missing", text: "That answer did not say which version it chooses. Nothing has changed." };
  }
  const chosen = chosenVariant(parsed.subject, variants);
  if (!chosen) {
    return { reason: "variant-unknown", text: "That is not one of the versions this gate offers. Nothing has changed." };
  }
  if (!chosen.preview_complete) {
    return {
      reason: "variant-incomplete",
      text: "That version couldn't be shown in full here — choose it on the board. Nothing has changed.",
    };
  }
  if (expired(chosen.expires_at, Date.now())) {
    return { reason: "variant-expired", text: "That version has expired, so it can no longer be chosen. Nothing has changed." };
  }
  return null;
}

/** What superpipeline's refusal of a decision becomes: the reason, and what is said in the room. */
async function refusalForCode(
  code: string,
  gateId: string,
  sender: string,
  roomId: string,
  deps: Pick<GateDecisionDeps, "reply">,
  quorum: MatrixGateQuorum | null,
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

  // A binding the board would not take: said in the room, because a person who chose a version and
  // saw nothing happen would choose it again.
  if (code === "APPROVAL_SUBJECT_MISMATCH") {
    log.warn("superpipeline refused a decision's subject binding", { gateId, code });
    await deps.reply(
      roomId,
      "The board did not accept that: what it approves is not one of this gate's versions, or was replaced. Open the card on the board. Nothing has changed.",
    );
    return { status: "refused", reason: "subject-mismatch" };
  }
  if (code === "DECISION_EXPIRED") {
    log.warn("superpipeline refused a decision on an expired subject", { gateId, code });
    await deps.reply(roomId, "That has expired, so it can no longer be approved. Nothing has changed.");
    return { status: "refused", reason: "subject-expired" };
  }

  // A quorum gate (charter 2026-11-09, more than one approver): said in the room, because a person
  // who approved and saw nothing happen would approve again. Only a quorum gate's refusal of who
  // decides is said here; on any other gate it stays as it was.
  if (code === "QUORUM_ALREADY_APPROVED") {
    log.info("superpipeline refused a second approval by the same person", { gateId });
    await deps.reply(roomId, "You have already approved this; it is waiting for other approvers. Nothing has changed.");
    return { status: "refused", reason: "quorum-already-approved" };
  }
  if (code === "APPROVAL_DECIDER_NOT_ALLOWED" && quorum) {
    log.info("superpipeline refused an approval that does not count toward a quorum", { gateId, from: quorum.from });
    await deps.reply(
      roomId,
      quorum.from === "admins"
        ? "This gate needs approvals from the workspace's owners and admins, so your approval does not count here. Nothing has changed."
        : "Your approval does not count for this gate: it needs approvals from its named deciders. Nothing has changed.",
    );
    return { status: "refused", reason: "decider-not-allowed" };
  }

  // An approval that could never act (charter 2026-11-09, an approval may wait for its release time
  // §5): the board recorded nothing, and the person is owed the reason rather than silence.
  if (code === "APPROVAL_RELEASE_AFTER_EXPIRY") {
    log.info("superpipeline refused an approval that would be released after its subject expires", { gateId });
    await deps.reply(
      roomId,
      "That can't be approved: it would go ahead only after what it approves has expired. Nothing has changed.",
    );
    return { status: "refused", reason: "release-after-expiry" };
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
): Promise<{ status: "resolved" } | { status: "recorded" } | { status: "refused"; reason: DecisionRefusal }> {
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

  // gate.v2: after attribution, so a stranger or an agent cannot make this hub speak. A v1 answer
  // carries no binding, so on a variant gate it can never be the choice.
  if (parsed.version === 1 && projection.variants && parsed.optionId === "approve") {
    await deps.reply(roomId, "Choose a version in an updated app or on the board. Nothing has changed.");
    return { status: "refused", reason: "subject-missing" };
  }
  if (parsed.version === 2) {
    const refusal = v2Refusal(parsed, projection);
    if (refusal) {
      log.warn("a gate.v2 decision was refused before it reached the board", {
        gateId: parsed.gateId,
        optionId: parsed.optionId,
        reason: refusal.reason,
      });
      await deps.reply(roomId, refusal.text);
      return { status: "refused", reason: refusal.reason };
    }
  }

  // On a variant gate the binding is the choice, carried only with an approval; request changes and
  // reject act on the whole set, and a stale binding beside them must not make the board refuse.
  const chosen = chosenVariant(parsed.subject, projection.variants);
  const approving = projection.options?.find((o) => o.id === parsed.optionId)?.meaning === "approve";
  const binding = projection.variants ? (approving && chosen ? parsed.subject : null) : parsed.subject;
  const result = await deps.resolveGate({
    tenantId: projection.tenantId,
    boardId: projection.boardId,
    gateId: parsed.gateId,
    decision: parsed.optionId,
    comment: parsed.comment,
    principalId: principal.id,
    senderMxid: event.sender,
    ...(binding ? { approvalSubject: binding } : {}),
  });

  if (result.ok) {
    // A quorum gate (charter 2026-11-09, more than one approver): the board accepting an approval is
    // not the gate passing. Only what the board's read says decides whether there is an outcome.
    if (projection.quorum && (approving || parsed.optionId === "approve")) {
      return settleQuorumApproval(roomId, parsed, principal.id, projection, deps, approving && chosen ? chosen : null);
    }
    // A gate this hub projected before it carried quorums has no stored quorum and may still need
    // more approvers. When the board can be read and says the gate is still pending, the approval was
    // recorded, not passed: nothing is said or claimed, and the board's progress push or the sweep
    // speaks for it. An unreadable gate keeps the behaviour every single-approval gate has.
    //
    // The same read says whether a resolved approval is held until its release time (charter
    // 2026-11-09, an approval may wait), which the receipt then names.
    let heldUntil: string | null = null;
    if (approving || parsed.optionId === "approve") {
      const read = await readBack(projection.boardId, parsed.gateId, deps);
      if (read?.status === "pending") return { status: "recorded" };
      if (read?.status === "resolved") heldUntil = heldUntilOf(read.heldUntil);
    }
    await postOutcomeReceipt(roomId, parsed, principal.id, projection, deps, approving && chosen ? chosen : null, heldUntil);
    return { status: "resolved" };
  }

  return refusalForCode(result.code, parsed.gateId, event.sender, roomId, deps, projection.quorum ?? null);
}

/** The board's read of a gate after an approval, or null when it cannot be had. */
async function readBack(
  boardId: string,
  gateId: string,
  deps: Pick<GateDecisionDeps, "readGate">,
): Promise<Awaited<ReturnType<NonNullable<GateDecisionDeps["readGate"]>>>> {
  if (!deps.readGate) return null;
  try {
    return await deps.readGate(boardId, gateId);
  } catch {
    return null;
  }
}

/**
 * After an approval of a quorum gate was accepted: read the gate back and post the outcome only when
 * the board says it resolved — with the board's decision, which the delivery rule may have made
 * manual although this person chose automatic. Still pending: nothing is said here; the board's
 * `gate.approval_recorded` carries the progress (`gate-progress.ts`). A read that fails leaves the
 * outcome to the gate sweep, which settles every posted gate the board reports resolved.
 */
async function settleQuorumApproval(
  roomId: string,
  parsed: ParsedGateDecision,
  principalId: string,
  projection: { boardId: string; eventId: string; proseEventId?: string | null },
  deps: GateDecisionDeps,
  chosen: { id: string; label: string } | null,
): Promise<{ status: "resolved" } | { status: "recorded" }> {
  let gate: Awaited<ReturnType<NonNullable<GateDecisionDeps["readGate"]>>> = null;
  try {
    gate = (await deps.readGate?.(projection.boardId, parsed.gateId)) ?? null;
  } catch (err) {
    log.warn("could not read a quorum gate back after an approval; the sweep settles it", {
      gateId: parsed.gateId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!gate || gate.status !== "resolved" || !gate.decision) {
    log.info("an approval of a quorum gate was recorded; the gate is not resolved", {
      gateId: parsed.gateId,
      status: gate?.status ?? "unread",
    });
    return { status: "recorded" };
  }
  await settleGateOutcome(
    {
      gateId: parsed.gateId,
      decision: gate.decision,
      decidedBy: gate.decidedBy ?? principalId,
      chosen: gate.chosen ?? chosen,
      heldUntil: heldUntilOf(gate.heldUntil),
    },
    roomId,
    projection,
    deps,
  );
  return { status: "resolved" };
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
  chosen: { id: string; label: string } | null,
  heldUntil: string | null,
): Promise<void> {
  await settleGateOutcome(
    {
      gateId: parsed.gateId,
      decision: parsed.optionId,
      decidedBy: principalId,
      ...(chosen ? { chosen } : {}),
      ...(heldUntil ? { heldUntil } : {}),
    },
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
  decided: {
    gateId: string;
    decision: string;
    decidedBy: string | null;
    /** The variant an approval chose, on a variant gate, when it is known. */
    chosen?: { id: string; label: string } | null;
    /**
     * A held approval's release time (charter 2026-11-09, an approval may wait for its release
     * time §7): the receipt says it goes ahead then, unless pulled back, and carries `held_until`.
     */
    heldUntil?: string | null;
  },
  roomId: string,
  projection: { boardId: string; eventId: string; proseEventId?: string | null },
  deps: Pick<GateDecisionDeps, "markOutcomePosted" | "displayNameFor" | "reply" | "sendOutcome">,
): Promise<void> {
  const parsed = { gateId: decided.gateId, optionId: decided.decision } as ParsedGateDecision;
  const principalId = decided.decidedBy;
  try {
    if (deps.markOutcomePosted && !(await deps.markOutcomePosted(parsed.gateId))) return;

    const who = principalId ? ((await deps.displayNameFor?.(principalId)) ?? null) : null;
    const verb = outcomeVerb(parsed.optionId, decided.chosen ?? null);
    const heldUntil = heldUntilOf(decided.heldUntil);
    const tail = heldUntil ? heldTail(heldUntil) : "the board has it.";
    const body = OUTCOME_SENTENCES[parsed.optionId] ?? (who ? `${verb} by ${who} — ${tail}` : `${verb} — ${tail}`);

    await deps.reply(roomId, body);

    // The gate's own event is what a card is drawn from, so the receipt points at it
    // rather than at the prose: a client that finds this knows which card to close.
    await deps.sendOutcome?.(roomId, {
      suite_event_type: GATE_OUTCOME_TYPE,
      gate_id: parsed.gateId,
      board_id: projection.boardId,
      decision: parsed.optionId,
      decided_by: who,
      ...(decided.chosen ? { chosen_variant: { id: decided.chosen.id, label: decided.chosen.label } } : {}),
      ...(heldUntil ? { held_until: heldUntil } : {}),
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

/**
 * How a decision reads in a sentence; an approval that chose a variant names it
 * ("Approved "Short version" for automatic delivery").
 */
function outcomeVerb(decision: string, chosen: { label: string } | null): string {
  const verb = OUTCOME_VERBS[decision] ?? decision;
  if (!chosen || !verb.startsWith("Approved")) return verb;
  return `Approved "${chosen.label}"${verb.slice("Approved".length)}`;
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
  expired: "Expired",
};

/**
 * Outcomes nobody chose, said as a whole sentence. A subject-bound gate whose subject passed its
 * `expires_at` is closed by the board as `expired` (charter: "Unanswered decisions remind, then
 * escalate" §7), and "Expired — the board has it" would read as though someone had answered.
 */
const OUTCOME_SENTENCES: Record<string, string> = {
  expired: "Expired — what this gate approves passed its expiry before anyone approved it, so it can no longer be approved here.",
};
