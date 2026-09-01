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
import { stationSpeaker } from "./names";
import { principalHandle } from "../principals";
import { roomForStation } from "./station-room";
import { moveInProgress } from "./identity-move";

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
  /**
   * What the reviewer is being asked to approve — the previous stage's
   * handoff, bounded by the board at 600 characters.
   *
   * Optional because a board that has not shipped kaambaan#… yet sends none,
   * and a gate without it must still render.
   */
  handoffSummary?: string | null;
  options: Array<{ id: string; label: string }>;
  ts: string;
}

/**
 * Is this a gate this hub knows how to post?
 *
 * Used on both inbound paths — the signed push and the sweep's read — because
 * "authenticated" is not "checked". A board a version ahead, or behind, would
 * otherwise have this hub posting a card with an empty title and no buttons
 * into somebody's room. One predicate rather than two so the two paths cannot
 * come to disagree about what a gate is.
 */
export function isGatePending(v: unknown): v is GatePendingDelivery {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d.event === "gate.pending" &&
    typeof d.boardId === "string" &&
    typeof d.cardId === "string" &&
    typeof d.gateId === "string" &&
    d.gateId.length > 0 &&
    typeof d.stageKey === "string" &&
    typeof d.cardTitle === "string" &&
    Array.isArray(d.options)
  );
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
  /**
   * There is no room to post into at all. `midMove` for the same reason
   * `no-agent` and `no-speaker` carry it (spec §6 names all three): a station
   * whose room set changed while its identity was moving produces this, and a
   * stuck-gate line that cannot tell a move from a fault turns every move into
   * an alarm. Absent means "not attributed" — there is no station behind this
   * card at all, so there is nothing to ask.
   */
  | { status: "no-room"; midMove?: boolean }
  /**
   * The room exists, but its station currently has no occupying agent — no
   * handle, and therefore no mxid to post the gate as. Distinct from
   * `no-room`, which means there is nowhere to post at all; this means there
   * is a room but nobody to speak in it as, which must refuse rather than
   * invent an address from `(nodeName, stationKey)`.
   *
   * `midMove` — carried by this status, by `no-speaker` and by `no-room`, the
   * three §6 names — says the station is between an authorised identity move and
   * its convergence (`identity-move.ts`'s `moveInProgress`). Spec §6: a
   * station mid-move must not read as healthy, and must not read as a FAULT
   * either, and these two statuses are exactly what a fault looks like.
   * Optional, so absent means "not attributed" rather than "not moving"; it
   * is read by `gate-sweep.ts`'s per-gate warning, which is where an operator
   * meets it.
   */
  | { status: "no-agent"; midMove?: boolean }
  /**
   * The room exists and its station HAS an occupying agent, but the station
   * answers for itself on Matrix and has never reported the account it
   * answers as (`stations.matrix_id`). Distinct from `no-agent`: there is
   * an agent, and the missing thing is the harness's own identity. Posting
   * as `@agent_<handle>` anyway is what this status replaced — an mxid the
   * bridge never registered, in a room it never joined.
   */
  | { status: "no-speaker"; midMove?: boolean };

/**
 * Which station this fleet dispatched a card to, if any.
 *
 * Split out of `roomForCard` so the no-room path can still name a station:
 * `roomForCard` answers null for three different reasons, and only one of them
 * ("nothing here ever ran this card") means there is nobody to attribute an
 * outcome to. Without this, a gate whose station's room went missing mid-move
 * was indistinguishable from a gate on somebody else's work.
 */
async function dispatchedStationId(
  tenantId: string,
  boardId: string,
  cardId: string
): Promise<string | null> {
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
  return dispatch?.stationId ?? null;
}

/**
 * The room a card's work happened in.
 *
 * `bridge_dispatches` already records which station claimed a card, indexed on
 * exactly this tuple, so the binding is free — the hub's own bridge wrote it
 * when it dispatched the work.
 *
 * card → dispatch → station → `roomForStation` (`station-room.ts`): the
 * dispatch names a station, and its CURRENT occupant's own room — never a
 * departed occupant's, however that occupant's assignment ended — is what a
 * gate lands in. So an agent reassigned to a brand-new station still speaks
 * in the room it has always had. This is the entire reason an agent's mxid
 * comes from its handle rather than `(nodeName, stationKey)`.
 *
 * Fix round 2 moved the actual resolution into `station-room.ts`, shared
 * with `routes/station-say.ts` and `provision.ts` — the round-1 version
 * inlined the same logic here alone, and a review found two more call
 * sites making the bug this function was written to close (P leaves a
 * station, Q takes it, and something still answers as if P were still
 * there). `gate-sweep.ts` is unaffected: it calls into this function
 * rather than querying `matrix_rooms` itself, and it is deployed in
 * production today.
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
): Promise<{
  roomId: string;
  stationId: string;
  nodeName: string;
  stationKey: string;
  principalId: string | null;
  identityMode: string;
  harnessMxid: string | null;
} | null> {
  const stationId = await dispatchedStationId(tenantId, boardId, cardId);
  if (!stationId) return null;

  const [station] = await db
    .select({
      stationKey: stations.stationKey,
      nodeName: nodes.name,
      // Who this hub may speak as here. Carried out of the same row rather
      // than re-derived downstream — the whole-branch review's Minor was
      // that `projectGate` assumed the bridge answered for every station
      // and posted as `@agent_<handle>` into harness-mode rooms, where that
      // account was never registered and never a member.
      identityMode: stations.matrixIdentityMode,
      harnessMxid: stations.matrixId,
    })
    .from(stations)
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .where(eq(stations.id, stationId))
    .limit(1);
  if (!station) return null;

  // The one resolver every station→room lookup in this codebase routes
  // through — see `station-room.ts`. It, not this function, decides
  // whether an occupied station's room is real yet, or falls back to the
  // plain `stationId` join for a station with no occupant at all.
  const occupancy = await roomForStation(stationId);
  if (!occupancy.room) return null;

  return {
    roomId: occupancy.room.roomId,
    stationId,
    nodeName: station.nodeName,
    stationKey: station.stationKey,
    principalId: occupancy.principalId,
    identityMode: station.identityMode,
    harnessMxid: station.harnessMxid,
  };
}

/**
 * The sentence a stock client sees.
 *
 * The link is written as **markdown**, not as a bare URL, and that is the whole
 * reason it is tappable. supermessage parses a plain `body` with
 * `blocks_from_markdown` when the event carries no `formatted_body`
 * (`item_view.rs`), and pulldown-cmark does not autolink bare URLs — so
 * `https://…` sitting in prose renders as characters to retype. It looks like a
 * link and is not, which is worse than omitting it.
 */
export function gateProseBody(d: GatePendingDelivery, link?: string): string {
  const where = `at stage \`${d.stageKey}\``;
  const tail = link ? ` [Open the card](${link})` : "";
  return `Approval needed — "${d.cardTitle}" ${where}. Approve, request changes, or reject.${tail}`;
}

/**
 * Where the card's link goes.
 *
 * `…/b/<board>/c/<card>` — the address kaambaan#34 assumed and kaambaan did
 * not have. This projected that shape for a day and it returned 404, because
 * the board app had no routing at all: one page, no `$page`, no
 * `searchParams`, no card route. It was briefly changed to the app root, and
 * is now back to the card because kaambaan/#47 made cards addressable.
 *
 * Worth keeping the history in view: the field was in the schema and in the
 * tests for a day before anyone tapped it. A test that asserts a link is
 * *present* proves nothing about whether it *resolves*, which is why the
 * kaambaan side is covered by end-to-end tests that follow it.
 */
function boardLink(baseUrl: string | undefined, boardId: string, cardId: string): string | undefined {
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/+$/, "")}/b/${encodeURIComponent(boardId)}/c/${encodeURIComponent(cardId)}`;
}

/** The custom event's content. Pinned by the shared fixture. */
export function gateEventContent(
  d: GatePendingDelivery,
  deepLink?: string
): Record<string, unknown> {
  const options = d.options.filter((o) => isGateOptionId(o.id));
  return {
    body: gateProseBody(d, deepLink),
    schema_version: 2,
    board_id: d.boardId,
    card_id: d.cardId,
    gate_id: d.gateId,
    stage_key: d.stageKey,
    return_stage_key: d.returnStageKey,
    card_title: d.cardTitle,
    produced_by: d.producedBy,
    prompt: `Approve "${d.cardTitle}"?`,
    // supermessage#37: without this the card asks a reviewer to approve work
    // it does not show them. Additive, so `schema_version` moves rather than
    // the type — a renderer written against v1 ignores it and still draws the
    // buttons.
    ...(d.handoffSummary ? { handoff_summary: d.handoffSummary } : {}),
    options,
    ...(deepLink ? { deep_link: deepLink } : {}),
  };
}

/**
 * Give back a claim this delivery took and could not use.
 *
 * Without it the row sits at `pending:<gateId>` forever and `gate-sweep.ts`
 * reads it as handled, so a gate that becomes sendable later — the station
 * gains an occupant, or the harness finally reports its mxid — is never
 * re-attempted.
 */
async function releaseClaim(gateId: string): Promise<void> {
  await db.delete(matrixGateEvents).where(eq(matrixGateEvents.gateId, gateId));
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
    // Attributed to a move where there IS a station to attribute it to. A card
    // this fleet never dispatched has none, and `midMove` stays absent rather
    // than becoming a false `false`. The extra lookup is on the failure path
    // only — `roomForCard` already answered for the ordinary one.
    const stationId = await dispatchedStationId(tenantId, d.boardId, d.cardId);
    const midMove = stationId ? await moveInProgress(stationId) : undefined;
    log.info("gate has no room to appear in", {
      gateId: d.gateId,
      cardId: d.cardId,
      stationId,
      midMove,
    });
    return midMove === undefined ? { status: "no-room" } : { status: "no-room", midMove };
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
  // them: from its occupying agent's handle, never from `(nodeName,
  // stationKey)`. Registering or sending as anything else lands outside the
  // exclusive `@agent_.*` namespace, where the appservice may not act — a 403
  // that arrives later and elsewhere. See `names.ts`.
  const handle = found.principalId ? await principalHandle(found.principalId) : null;
  if (!handle) {
    // The claim must go, or a gate for a station that later gains an
    // occupying agent could never be re-attempted — the sweep would see the
    // claimed row and conclude it had already been handled.
    await releaseClaim(d.gateId);
    const midMove = await moveInProgress(found.stationId);
    log.warn("gate's station has no occupying agent; claim released", {
      gateId: d.gateId,
      stationKey: found.stationKey,
      midMove,
    });
    return { status: "no-agent", midMove };
  }

  // …and WHICH virtual user is `names.ts`'s `stationSpeaker`, not
  // `bridgeUserId` applied unconditionally, which is what this line was.
  // A harness-mode station's room was created by the account the harness
  // holds (`stations.matrix_id`), and `provision.ts` deliberately never
  // calls `ensureUser` for such a station — so `@agent_<handle>` there is an
  // mxid nothing registered, in a room it never joined. The homeserver
  // refuses, and the gate is lost with its claim already taken. Speaking as
  // the identity that actually owns the room is the only send that can land.
  const stationUser = stationSpeaker(
    { identityMode: found.identityMode, harnessMxid: found.harnessMxid, handle },
    deps.domain
  );
  if (!stationUser) {
    // Harness mode with no reported mxid: there is a room and an occupant,
    // and still nobody this hub may speak as. Released for the same reason
    // as above — the node agent reports `matrix_id`, so this can become
    // sendable later without anything else changing.
    await releaseClaim(d.gateId);
    // Attributed to the move when there is one (§6): a station between
    // authorisation and convergence is waiting, not broken, and a sweep that
    // reports the two as the same thing is how a move gets mistaken for the
    // outage it exists to avoid.
    const midMove = await moveInProgress(found.stationId);
    log.warn("gate's station answers for itself but has reported no Matrix identity; claim released", {
      gateId: d.gateId,
      stationKey: found.stationKey,
      midMove,
    });
    return { status: "no-speaker", midMove };
  }
  const deepLink = boardLink(deps.boardBaseUrl, d.boardId, d.cardId);

  // Prose first, deliberately: if only one lands, leave the room with a
  // readable question and no buttons rather than buttons and no context.
  //
  // **A send that THROWS gives the claim back** — fix round 2, and the reason
  // is a state this slice itself created. A station whose identity move left
  // it answering as an mxid its room does not contain has a non-null
  // `stationSpeaker`, so the outcome is never `no-speaker`; the homeserver
  // 403s, `assertOkOrAlready` throws, and this used to throw straight out with
  // the claim already taken. The row then sat at `pending:<gateId>` forever,
  // every later pass answered `already` — which the sweep treats as the
  // healthy answer and deliberately does not warn on — and the gate was
  // invisible on both sides. A person waiting on an approval, and a fleet
  // reporting nothing wrong.
  //
  // Releasing is the same trade the `!eventId` branch below already makes, and
  // it is made knowingly: if the prose landed and the custom event threw, the
  // next pass posts the prose again. A room that reads the question twice is a
  // cost; a question never asked is the failure this file exists to prevent.
  //
  // Re-thrown rather than turned into an outcome, so the push receiver keeps
  // answering 5xx and kaambaan keeps retrying. Converting a failure into a 200
  // would quietly retire push's own retry, leaving the sweep as the only path
  // — and the sweep counts this now (`gate-sweep.ts`), so a throw can no
  // longer be missing from the tally either.
  let eventId: string | null;
  try {
    await deps.sendText(stationUser, found.roomId, gateProseBody(d, deepLink));

    eventId = await deps.sendCustomEvent(
      stationUser,
      found.roomId,
      GATE_EVENT_TYPE,
      gateEventContent(d, deepLink)
    );
  } catch (err) {
    await releaseClaim(d.gateId);
    log.warn("gate could not be posted into its room; claim released so a later pass retries", {
      gateId: d.gateId,
      roomId: found.roomId,
      stationUser,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (!eventId) {
    // The claim has to go, or this gate can never be projected again — the
    // sweep would see a row and conclude it had been handled.
    await db.delete(matrixGateEvents).where(eq(matrixGateEvents.gateId, d.gateId));
    const midMove = await moveInProgress(found.stationId);
    log.warn("gate event was not accepted; claim released", {
      gateId: d.gateId,
      stationId: found.stationId,
      midMove,
    });
    return { status: "no-room", midMove };
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

/**
 * Resolve a gate at kaambaan **as the human**, using a short-lived assertion.
 *
 * This is the function `charter →
 * decisions/2026-08-14-approvals-cross-planes-as-events.md` is about. The
 * alternative — calling with this service's own `kbn_` agent token — would work
 * on the first try and make every approval in the suite attribute to one
 * account, voiding kaambaan's separation-of-duties check while appearing to
 * succeed. That is why the token is minted per decision rather than held.
 *
 * `principalId` must have come from `principal_identities`. See
 * `mintPrincipalAssertion`, which says the same thing louder.
 */
export async function resolveGateAtKaambaan(
  input: {
    boardId: string;
    gateId: string;
    decision: GateOptionId;
    comment: string | null;
    principalId: string;
  },
  deps: {
    baseUrl: string;
    mint(principalId: string): Promise<string>;
    fetch?: typeof fetch;
  }
): Promise<{ ok: true } | { ok: false; code: string }> {
  const token = await deps.mint(input.principalId);
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");

  let res: Response;
  try {
    res = await doFetch(
      `${base}/v1/boards/${encodeURIComponent(input.boardId)}/gates/${encodeURIComponent(input.gateId)}/resolve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision: input.decision,
          ...(input.comment ? { comment: input.comment } : {}),
        }),
      }
    );
  } catch (err) {
    // The network, not a refusal. Distinguished because a refusal is final and
    // this is not — the reader should be able to press the button again.
    log.warn("gate resolution did not reach the board", {
      gateId: input.gateId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNREACHABLE" };
  }

  if (res.ok) return { ok: true };

  // kaambaan answers with `{ error: { code } }`. The code is what matters:
  // it answers 403 for SEPARATION_OF_DUTIES and 409 for GATE_NOT_PENDING, and
  // those are different situations with the same shape.
  let code = `HTTP_${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    if (body.error?.code) code = body.error.code;
  } catch {
    // Keep the status-derived code.
  }
  return { ok: false, code };
}

/** What this hub recorded when it posted a gate, or null if it never did. */
export async function projectionForGate(gateId: string): Promise<{
  tenantId: string;
  boardId: string;
  eventId: string;
} | null> {
  const [row] = await db
    .select({
      tenantId: matrixGateEvents.tenantId,
      boardId: matrixGateEvents.boardId,
      eventId: matrixGateEvents.eventId,
    })
    .from(matrixGateEvents)
    .where(eq(matrixGateEvents.gateId, gateId))
    .limit(1);
  return row ?? null;
}

/**
 * The virtual user this hub speaks as in a given room.
 *
 * Used when a gate needs an answer *about* itself — "that was already decided"
 * — which must come from the agent whose room it is rather than from a bot
 * nobody invited.
 *
 * Answered from the room's OWN bound occupant (`matrixRooms.principalId`)
 * and from nothing else: a room keeps its resident even after that agent
 * moves to a different station, and a reply about an old gate must come from
 * the agent whose history is actually in this room.
 *
 * An UNBOUND room gets null — fix round 4, and a deliberate reversal. This
 * used to fall back to `stations.principalId`, the station's *current*
 * occupant, on the reasoning that a room from before the binding existed had
 * been speaking as that agent all along. Migration 0060 already backfilled
 * every such room, and what the fallback actually covers now is a room its
 * station's occupant never lived in — a harness-mode station's room,
 * provisioned while nobody occupied it (`provision.ts` writes
 * `principal_id: null` there), left behind when an occupant arrives who
 * already holds a room elsewhere. Answering that as the station's current
 * occupant puts the WRONG agent's name on a reply in somebody else's old
 * room. The schema genuinely cannot tell "never bound" from "a departed
 * occupant's, never bound" — but "cannot distinguish" argues for no answer,
 * not for a guess. The one caller (`index.ts`'s gate `reply`) already treats
 * null as "there is nobody to say this as" and stays silent, which is the
 * failure worth having: a missing reply is visible and recoverable, a
 * misattributed one is neither.
 */
export async function roomAgentUser(roomId: string, domain: string): Promise<string | null> {
  const [row] = await db
    .select({
      ownPrincipalId: matrixRooms.principalId,
      // The station is joined for its MODE, not for its occupant. Fix round
      // 4 removed a `stations.principal_id` fallback from here on purpose
      // and nothing below reinstates it: a room with no binding of its own
      // still answers null.
      identityMode: stations.matrixIdentityMode,
      harnessMxid: stations.matrixId,
    })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .where(eq(matrixRooms.roomId, roomId))
    .limit(1);
  if (!row?.ownPrincipalId) return null;
  const handle = await principalHandle(row.ownPrincipalId);
  if (!handle) return null;
  // Same rule as the send path, from the same function — a reply that goes
  // out as an identity the room's send path could not use would be the two
  // halves of one question answered two ways again.
  //
  // Known limit, stated rather than hidden: a station that changed modes
  // after this room was created is unknowable from the schema, which records
  // no creator. The mode is read live because it is the only answer there
  // is, and it is right for every room whose station has not changed modes.
  return stationSpeaker(
    { identityMode: row.identityMode, harnessMxid: row.harnessMxid, handle },
    domain
  );
}
