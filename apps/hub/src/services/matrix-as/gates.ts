/**
 * Projecting a kaambaan approval gate into the room where the work happened.
 *
 * `charter` → `decisions/2026-08-30-a-gate-closes-over-chat.md`. kaambaan owns
 * the gate; this only renders it and carries an answer back.
 *
 * ## Two events, not one
 *
 * A gate is sent as `dev.kaambaan.gate.v1` **and** as an ordinary prose
 * message beside it. That is this codebase's existing convention rather than a
 * new idea — `dev.agentpod.permission.v1` already does it, and supermessage's
 * `PermissionRequestRenderer` documents why: a client that never renders the
 * custom event is then "exactly as able to answer as it was". It matters here
 * because a stock Matrix client renders an unknown **event type** as nothing at
 * all. kaambaan#34 assumed a custom event's own `body` would be shown by every
 * client; that holds for an unknown *msgtype* and not for an unknown *type*.
 *
 * The prose goes first. If only one of the two lands, the room should be left
 * with a readable question and no buttons rather than buttons and no context.
 *
 * ## Why a gate can be delivered more than once, and must post once
 *
 * kaambaan's push is at-least-once within an attempt cap, its alarm re-picks
 * failed rows, and the sweep asks independently which pending gates have no
 * event. All three are meant to overlap. `matrix_gate_events` keyed on
 * `gate_id` is what turns that overlap into one question instead of three.
 */

import { and, eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { bridgeDispatches } from "../../db/schema/bridge";
import { matrixGateEvents, matrixRooms } from "../../db/schema/matrix";
import { nodes } from "../../db/schema/nodes";
import { stations } from "../../db/schema/stations";
import { createLogger } from "../../utils/logger";
import { bridgeUserId } from "./names";

const log = createLogger("matrix-gates");

export const GATE_EVENT_TYPE = "dev.kaambaan.gate.v1";
export const GATE_DECISION_SUITE_TYPE = "dev.kaambaan.gate.decision.v1";

/**
 * The only option ids kaambaan resolves against — its `GateDecision`.
 *
 * Mirrored here rather than imported because the two products share no runtime.
 * Pinned by `fixtures/ecosystem-identity/matrix_gate_events.json`, which both
 * repos validate against.
 */
export const GATE_OPTION_IDS = ["approve", "request_changes", "reject"] as const;
export type GateOptionId = (typeof GATE_OPTION_IDS)[number];

export const isGateOptionId = (v: unknown): v is GateOptionId =>
  typeof v === "string" && (GATE_OPTION_IDS as readonly string[]).includes(v);

/** The body kaambaan pushes on `gate.pending`. */
export interface GatePendingDelivery {
  event: "gate.pending";
  boardId: string;
  cardId: string;
  gateId: string;
  stageKey: string;
  returnStageKey: string;
  cardTitle: string;
  producedBy: string;
  options: Array<{ id: string; label: string }>;
  ts: string;
}

export interface GateProjectionDeps {
  /** Sends as a station's own virtual user. Returns the event id, or null. */
  sendCustomEvent(
    userId: string,
    roomId: string,
    eventType: string,
    content: Record<string, unknown>
  ): Promise<string | null>;
  sendText(userId: string, roomId: string, body: string): Promise<string | null>;
  /** The homeserver's domain, for building the station's mxid. */
  domain: string;
  /** Where a card's deep link points. */
  boardBaseUrl?: string;
}

export type ProjectionOutcome =
  | { status: "sent"; eventId: string; roomId: string }
  | { status: "already" }
  | { status: "no-room" };

/**
 * The room a card's work happened in.
 *
 * `bridge_dispatches` already records which station claimed a card, indexed on
 * exactly this tuple, so the binding is free — the hub's own bridge wrote it
 * when it dispatched the work.
 *
 * `null` when no AgentPod station ran the card. That is a real and named
 * limitation rather than a fault: a gate on work this fleet never touched has
 * no room to appear in, and inventing one would put an approval somewhere
 * nobody is looking.
 */
async function roomForCard(
  tenantId: string,
  boardId: string,
  cardId: string
): Promise<{ roomId: string; nodeName: string; stationKey: string } | null> {
  const [dispatch] = await db
    .select({ stationId: bridgeDispatches.stationId })
    .from(bridgeDispatches)
    .where(
      and(
        eq(bridgeDispatches.tenantId, tenantId),
        eq(bridgeDispatches.externalSource, "kaambaan"),
        eq(bridgeDispatches.boardId, boardId),
        eq(bridgeDispatches.externalCardId, cardId)
      )
    )
    .limit(1);
  if (!dispatch) return null;

  const [room] = await db
    .select({
      roomId: matrixRooms.roomId,
      stationKey: stations.stationKey,
      nodeName: nodes.name,
    })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .where(eq(matrixRooms.stationId, dispatch.stationId))
    .limit(1);
  if (!room) return null;

  return { roomId: room.roomId, nodeName: room.nodeName, stationKey: room.stationKey };
}

/** The sentence a stock client sees. */
export function gateProseBody(d: GatePendingDelivery, deepLink?: string): string {
  const where = `at stage \`${d.stageKey}\``;
  const tail = deepLink ? ` ${deepLink}` : "";
  return `Approval needed — "${d.cardTitle}" ${where}. Approve, request changes, or reject.${tail}`;
}

/** The custom event's content. Pinned by the shared fixture. */
export function gateEventContent(
  d: GatePendingDelivery,
  deepLink?: string
): Record<string, unknown> {
  const options = d.options.filter((o) => isGateOptionId(o.id));
  return {
    body: gateProseBody(d, deepLink),
    schema_version: 1,
    board_id: d.boardId,
    card_id: d.cardId,
    gate_id: d.gateId,
    stage_key: d.stageKey,
    return_stage_key: d.returnStageKey,
    card_title: d.cardTitle,
    produced_by: d.producedBy,
    prompt: `Approve "${d.cardTitle}"?`,
    options,
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}

/**
 * Post a gate into its station's room, exactly once.
 *
 * The insert is the gate on the send, not a record of it: `onConflictDoNothing`
 * returning no row means another delivery of the same gate got here first, and
 * this one stops without posting. Doing it the other way round — send, then
 * record — would post twice under a redelivery and record once.
 */
export async function projectGate(
  tenantId: string,
  d: GatePendingDelivery,
  deps: GateProjectionDeps
): Promise<ProjectionOutcome> {
  const found = await roomForCard(tenantId, d.boardId, d.cardId);
  if (!found) {
    log.info("gate has no room to appear in", { gateId: d.gateId, cardId: d.cardId });
    return { status: "no-room" };
  }

  // Claim the gate before sending. See this function's doc comment.
  const claimed = await db
    .insert(matrixGateEvents)
    .values({
      gateId: d.gateId,
      tenantId,
      boardId: d.boardId,
      cardId: d.cardId,
      roomId: found.roomId,
      // Replaced with the real id below. A row that exists with an empty event
      // id means "being sent"; the sweep treats it as taken, which is what
      // stops a concurrent delivery from posting the same question.
      eventId: `pending:${d.gateId}`,
    })
    .onConflictDoNothing({ target: matrixGateEvents.gateId })
    .returning({ gateId: matrixGateEvents.gateId });
  if (claimed.length === 0) {
    return { status: "already" };
  }

  // The station's own virtual user, built the one way this codebase builds
  // them. Registering or sending as anything else lands outside the exclusive
  // `@agent_.*` namespace, where the appservice may not act — a 403 that
  // arrives later and elsewhere. See `names.ts`.
  const stationUser = bridgeUserId(found.nodeName, found.stationKey, deps.domain);
  const deepLink = deps.boardBaseUrl
    ? `${deps.boardBaseUrl}/b/${d.boardId}/c/${d.cardId}`
    : undefined;

  // Prose first, deliberately: if only one lands, leave the room with a
  // readable question and no buttons rather than buttons and no context.
  await deps.sendText(stationUser, found.roomId, gateProseBody(d, deepLink));

  const eventId = await deps.sendCustomEvent(
    stationUser,
    found.roomId,
    GATE_EVENT_TYPE,
    gateEventContent(d, deepLink)
  );

  if (!eventId) {
    // The claim has to go, or this gate can never be projected again — the
    // sweep would see a row and conclude it had been handled.
    await db.delete(matrixGateEvents).where(eq(matrixGateEvents.gateId, d.gateId));
    log.warn("gate event was not accepted; claim released", { gateId: d.gateId });
    return { status: "no-room" };
  }

  await db
    .update(matrixGateEvents)
    .set({ eventId })
    .where(eq(matrixGateEvents.gateId, d.gateId));

  return { status: "sent", eventId, roomId: found.roomId };
}

// ---------------------------------------------------------------------------
// The way back: a human's answer becomes a resolution.
// ---------------------------------------------------------------------------

/** Why a decision event was not acted on. Every value is a refusal. */
export type DecisionRefusal =
  | "not-a-decision"
  | "unlinked-sender"
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
  principalForMatrixId(mxid: string): Promise<string | null>;
  /** The recorded projection for a gate, or null if this hub never posted it. */
  projectionFor(gateId: string): Promise<{
    tenantId: string;
    boardId: string;
    eventId: string;
  } | null>;
  /**
   * Resolve the gate at kaambaan **as `principalId`**, never as this service.
   *
   * The whole decision of 2026-08-14 rests here: a bridge that substituted its
   * own identity would make every approval in the suite attribute to one
   * account and void kaambaan's separation-of-duties check.
   */
  resolveGate(input: {
    tenantId: string;
    boardId: string;
    gateId: string;
    decision: GateOptionId;
    comment: string | null;
    principalId: string;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** Say something back in the room. Used when a gate was already resolved. */
  reply(roomId: string, body: string): Promise<unknown>;
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
  if (parsed.referencedEventId !== projection.eventId) {
    log.warn("decision's reference and gate disagree", {
      gateId: parsed.gateId,
      referenced: parsed.referencedEventId,
    });
    return { status: "refused", reason: "reference-mismatch" };
  }

  const principalId = await deps.principalForMatrixId(event.sender);
  if (!principalId) {
    // An unlinked Matrix user in a room is a case this must handle explicitly
    // (charter decisions/2026-08-13-ecosystem-identity.md, Decision 2). It is
    // not an error — someone may simply be in the room — so it is logged and
    // dropped rather than answered.
    log.info("decision from an unlinked sender, ignored", { sender: event.sender });
    return { status: "refused", reason: "unlinked-sender" };
  }

  const result = await deps.resolveGate({
    tenantId: projection.tenantId,
    boardId: projection.boardId,
    gateId: parsed.gateId,
    decision: parsed.optionId,
    comment: parsed.comment,
    principalId,
  });

  if (result.ok) return { status: "resolved" };

  if (result.code === "GATE_NOT_PENDING") {
    // Answered on the board, or a double tap on a slow connection. Not
    // swallowed: the person who tapped is owed the reason nothing happened.
    await deps.reply(roomId, "That was already decided — the board has it.");
    return { status: "refused", reason: "unknown-gate" };
  }

  log.warn("kaambaan refused a decision", { gateId: parsed.gateId, code: result.code });
  return { status: "refused", reason: "unknown-gate" };
}

/**
 * Which fleet a board's gates belong to.
 *
 * Answered from `bridge_dispatches` rather than from a board registry, because
 * there isn't one and shouldn't be: this hub knows a board exists only because
 * it dispatched work for it. A board it has never worked is a board whose gates
 * it has no business projecting — so "unknown board" is the right answer, and a
 * 404 is the right refusal.
 */
export async function tenantForBoard(boardId: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: bridgeDispatches.tenantId })
    .from(bridgeDispatches)
    .where(
      and(
        eq(bridgeDispatches.externalSource, "kaambaan"),
        eq(bridgeDispatches.boardId, boardId)
      )
    )
    .limit(1);
  return row?.tenantId ?? null;
}
