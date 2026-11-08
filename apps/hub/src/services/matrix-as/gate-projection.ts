/**
 * Posting a gate into its board's room, exactly once: the claim in `matrix_gate_events`, the
 * held-for-a-join answer, the prose and legacy sends, and giving a claim back.
 *
 * Split out of `gates.ts`, which re-exports it; the file header there says why a gate is two
 * events and why it must post once.
 */

import { eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { matrixGateEvents } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import { GATE_REQUEST_CONTENT_KEY } from "@agentpod/contract";
import { noteHubEvent } from "../push";
import { legacyRequestEvents } from "./legacy-events";
import type { GatePendingDelivery } from "../bridge";
import {
  GATE_EVENT_TYPE,
  boardLink,
  gateEventContent,
  gateOptionsV2,
  gateRequestCard,
  gateSubjectV2,
  gateV2Content,
  gateVariantsV2,
} from "./gate-wire";

const log = createLogger("matrix-gates");

export interface GateProjectionDeps {
  /**
   * The board's room, made if it is not there yet.
   *
   * Injected rather than imported so a projection can be tested without a
   * homeserver, and so the room's lifecycle stays in `board-room.ts` where its
   * ordering rules live (encrypt before recording; never record one that could not
   * be encrypted).
   */
  boardRoom(
    boardId: string,
    tenantId: string,
    opts?: { boardName?: string },
  ): Promise<{ roomId: string; speakerMxid: string } | null>;

  /**
   * Whether anybody but the board's speaker has JOINED the room — not merely been invited.
   *
   * 2026-10-07, room !LEug4KhmCbPF9HMHqY: a board's first gate made the board room,
   * invited the human and posted at once. They had not accepted yet, so the card was
   * encrypted to the speaker alone and could never be read on their devices. A gate is
   * therefore held until this answers true (operator decision: the gate arrives after
   * the human has joined). Optional so a caller that builds no board room keeps working;
   * production wires it (`src/index.ts`). A throw is a send failure like any other.
   */
  humanJoined?(roomId: string, speakerMxid: string): Promise<boolean>;

  /** Sends as a station's own virtual user. Returns the event id, or null. */
  sendCustomEvent(
    userId: string,
    roomId: string,
    eventType: string,
    content: Record<string, unknown>
  ): Promise<string | null>;
  /** `extra` carries the embedded gate (`dev.superpipeline.gate`) beside the body. */
  sendText(
    userId: string,
    roomId: string,
    body: string,
    extra?: Record<string, unknown>
  ): Promise<string | null>;
  /** The homeserver's domain, for building the station's mxid. */
  domain: string;
  /** Where a card's deep link points. */
  boardBaseUrl?: string;
  /**
   * Told once the gate is in its room — the fleet Live Activity shows it as
   * a pending decision (`fleet-gates.ts`). Best-effort: a failure here is
   * logged and costs the Lock Screen card, never the gate.
   */
  onPosted?(d: GatePendingDelivery, posted: { roomId: string; eventId: string; proseEventId: string | null }): Promise<void>;
}

export type ProjectionOutcome =
  | { status: "sent"; eventId: string; roomId: string }
  | { status: "already" }
  /**
   * The board room exists but nobody has joined it yet, so the gate is held rather
   * than encrypted to the speaker alone. No claim is taken: the hold lives in
   * superpipeline's pending list, which the sweep and the join trigger both re-read,
   * so neither a late join nor a hub restart can lose it.
   */
  | { status: "awaiting-join"; roomId: string }
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
 * A held gate's answer: `already` when a row exists, whatever the room's membership is now,
 * and otherwise `awaiting-join`, leaving no row behind.
 */
async function heldForJoin(d: GatePendingDelivery, roomId: string): Promise<ProjectionOutcome> {
  const [posted] = await db
    .select({ gateId: matrixGateEvents.gateId })
    .from(matrixGateEvents)
    .where(eq(matrixGateEvents.gateId, d.gateId))
    .limit(1);
  if (posted) return { status: "already" };
  log.info("gate held until a human joins its board room", {
    gateId: d.gateId,
    boardId: d.boardId,
    roomId,
  });
  return { status: "awaiting-join", roomId };
}

/**
 * Take the gate's claim; false when another delivery of the same gate already holds it.
 *
 * The claim also records what the gate offered and the subject it is bound to, or the variants it
 * offers a choice of — exactly what its gate.v2 carries — because a decision.v2 is checked against
 * them, not against a list.
 */
async function claimGate(tenantId: string, d: GatePendingDelivery, roomId: string): Promise<boolean> {
  const subject = gateSubjectV2(d);
  const variants = gateVariantsV2(d);
  const claimed = await db
    .insert(matrixGateEvents)
    .values({
      gateId: d.gateId,
      tenantId,
      boardId: d.boardId,
      cardId: d.cardId,
      roomId,
      // Replaced with the real id below. A row that exists with an empty event
      // id means "being sent"; the sweep treats it as taken, which is what
      // stops a concurrent delivery from posting the same question.
      eventId: `pending:${d.gateId}`,
      options: gateOptionsV2(d),
      approvalSubjectId: subject?.id ?? null,
      approvalSubjectDigest: subject?.digest ?? null,
      approvalSubjectPreviewComplete: subject?.preview_complete ?? null,
      approvalVariants:
        variants?.map((v) => ({
          id: v.id,
          label: v.label,
          subject_id: v.subject.id,
          digest: v.subject.digest,
          preview_complete: v.subject.preview_complete,
          expires_at: v.subject.expires_at,
        })) ?? null,
    })
    .onConflictDoNothing({ target: matrixGateEvents.gateId })
    .returning({ gateId: matrixGateEvents.gateId });
  return claimed.length > 0;
}

/** Send the prose (carrying the card) and, while legacy events are on, the custom event. */
async function sendGateEvents(
  d: GatePendingDelivery,
  roomId: string,
  stationUser: string,
  deepLink: string | undefined,
  deps: GateProjectionDeps
): Promise<{ eventId: string | null; proseEventId: string | null }> {
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
  // Releasing is the same trade the `!eventId` branch in `projectGate` makes, and
  // it is made knowingly: if the prose landed and the custom event threw, the
  // next pass posts the prose again. A room that reads the question twice is a
  // cost; a question never asked is the failure this file exists to prevent.
  //
  // Re-thrown rather than turned into an outcome, so the push receiver keeps
  // answering 5xx and superpipeline keeps retrying. Converting a failure into a 200
  // would quietly retire push's own retry, leaving the sweep as the only path
  // — and the sweep counts this now (`gate-sweep.ts`), so a throw can no
  // longer be missing from the tally either.
  //
  // The gate rides INSIDE the prose (`dev.superpipeline.gate`) so the one
  // question is one event and one push — a push the phone can classify even in
  // an unencrypted room, where the custom type matches no push rule. The
  // custom event still follows while clients in the field read only it
  // (`AGENTPOD_LEGACY_PERMISSION_EVENTS`, default on); with it off, the prose is
  // the event a decision references.
  //
  // **The prose IS the gate.v2** (charter → `decisions/2026-11-07-gate-v2-is-the-decision-envelope.md`):
  // its content carries the `dev.superpipeline.gate.v2` marker and the v2 fields beside the v1
  // card, so a v2 client and a v1 client read the same single event and push, and a
  // decision.v2 references it like any other. For a subject-bound gate its body shows the
  // preview; for any other gate the body is the v1 sentence, unchanged.
  let eventId: string | null;
  let proseEventId: string | null;
  try {
    const { body, ...v2 } = gateV2Content(d, deepLink);
    proseEventId = await deps.sendText(stationUser, roomId, String(body), {
      ...v2,
      [GATE_REQUEST_CONTENT_KEY]: gateRequestCard(d, deepLink),
    });
    noteHubEvent(proseEventId, "gate");

    if (legacyRequestEvents()) {
      eventId = await deps.sendCustomEvent(
        stationUser,
        roomId,
        GATE_EVENT_TYPE,
        gateEventContent(d, deepLink)
      );
      // The prose already pushed; the companion must not buzz a second time.
      if (proseEventId) noteHubEvent(eventId, "companion");
    } else {
      eventId = proseEventId;
    }
  } catch (err) {
    await releaseClaim(d.gateId);
    log.warn("gate could not be posted into its room; claim released so a later pass retries", {
      gateId: d.gateId,
      roomId,
      stationUser,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return { eventId, proseEventId };
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
  /**
   * The board's room, not the station's.
   *
   * `charter → decisions/2026-09-28-a-gate-belongs-to-its-board-not-to-an-agents-room.md`.
   * A station room belongs to a harness-mode agent that owns its own keys: this hub
   * encrypts there (which `bridge-agents.ts` says it must never do) and correctly
   * refuses to decrypt there, so a gate could be delivered and never answered. On
   * 2026-09-28 an operator approved from their phone and the decision was discarded
   * unread.
   *
   * A board room is spoken by an identity whose keys the hub holds outright, which
   * is the only arrangement where both halves work. It also removes three failure
   * modes that existed only because a gate borrowed a station: an unoccupied
   * station, a station answering as an mxid nothing registered, and a station
   * mid-identity-move. A board is always there.
   */
  const found = await deps.boardRoom(d.boardId, tenantId, { boardName: d.boardName ?? undefined });
  if (!found) {
    // No `midMove` here any more, and nothing to attribute it to. A board room
    // failing to exist is the hub being unable to make or encrypt one — a fault in
    // this service, not a station between authorisation and convergence.
    log.warn("gate has no board room to appear in", {
      gateId: d.gateId,
      cardId: d.cardId,
      boardId: d.boardId,
    });
    return { status: "no-room" };
  }

  // Held, not posted, until somebody has joined to receive the room key — see
  // `humanJoined`. Asked before the claim so a held gate leaves no row behind.
  if (deps.humanJoined && !(await deps.humanJoined(found.roomId, found.speakerMxid))) {
    return heldForJoin(d, found.roomId);
  }

  // Claim the gate before sending. See this function's doc comment.
  if (!(await claimGate(tenantId, d, found.roomId))) {
    return { status: "already" };
  }

  /**
   * The board speaks, not the agent.
   *
   * `gates.ts` already said the truth of it — superpipeline owns the gate and this
   * only renders it — and attributing it to the agent was the fiction that broke
   * it. The speaker comes from the room's own record rather than being rebuilt, so
   * a room made by one identity is never spoken into by another.
   */
  const stationUser = found.speakerMxid;

  const deepLink = boardLink(deps.boardBaseUrl, d.boardId, d.cardId);

  const { eventId, proseEventId } = await sendGateEvents(d, found.roomId, stationUser, deepLink, deps);

  if (!eventId) {
    // The claim has to go, or this gate can never be projected again — the
    // sweep would see a row and conclude it had been handled.
    await db.delete(matrixGateEvents).where(eq(matrixGateEvents.gateId, d.gateId));
    // No `midMove`: a board room has no identity move to be between. The send was
    // refused and the claim is given back so the sweep re-offers it.
    log.warn("gate event was not accepted; claim released", {
      gateId: d.gateId,
      boardId: d.boardId,
      roomId: found.roomId,
    });
    return { status: "no-room" };
  }

  await db
    .update(matrixGateEvents)
    .set({ eventId, proseEventId })
    .where(eq(matrixGateEvents.gateId, d.gateId));

  await deps.onPosted?.(d, { roomId: found.roomId, eventId, proseEventId }).catch((err) =>
    log.warn("gate posted but not shown on the fleet card", {
      gateId: d.gateId,
      error: err instanceof Error ? err.message : String(err),
    })
  );

  return { status: "sent", eventId, roomId: found.roomId };
}
