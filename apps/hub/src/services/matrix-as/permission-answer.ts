/**
 * AgentPod judging a harness permission answer from a station room.
 *
 * charter → "Strict decisions and harness permissions bind their subject" §6. A
 * `dev.agentpod.permission.answer.v2` names its request, the option and the binding; the hub checks
 * the session, the sequence, the digest, that the option was offered, that the request is still
 * pending and unexpired, and (in `inbound.ts`, before this runs) the answerer's grant — then answers
 * the agent and records who answered. A late or stale answer, structured or a typed number, is
 * refused with a reply in the room and is never passed to the agent as a prompt.
 *
 * The record judged against is `matrix_permission_requests` (`permission-records.ts`).
 */

import { createLogger } from "../../utils/logger";
import type { PermissionAnswerer } from "../acp";
import {
  closePermission,
  expiredPendingPermissions,
  latestPermissionInRoom,
  permissionRecord,
  promptedSince,
  type PermissionRecord,
} from "./permission-records";
import {
  PERMISSION_TTL_MS,
  permissionOutcomeContent,
  permissionOutcomeText,
  permissionRequestId,
  type ParsedPermissionAnswer,
  type PermissionOutcome,
} from "./permission-wire";
import { clearPendingPermission, matchPermissionAnswer, pendingPermissionFor } from "./permissions";

const log = createLogger("matrix-permissions");

/** Why a permission answer was not carried to the agent. Every value is a refusal. */
export type PermissionAnswerRefusal =
  | "not-an-answer"
  | "unknown-request"
  | "reference-mismatch"
  | "other-session"
  | "subject-missing"
  | "subject-mismatch"
  | "bad-option"
  | "not-pending"
  | "expired"
  | "preview-incomplete"
  | "agent-refused";

export type PermissionAnswerOutcome = { status: "answered"; requestId: string } | { status: "refused"; reason: PermissionAnswerRefusal };

/** What answering needs from the room it arrived in, already past the identity and grant checks. */
export interface PermissionAnswerContext {
  roomId: string;
  /** The session the room speaks to now; an answer for any other session is stale. */
  sessionId: string | null;
  answerer: { principalId: string; mxid: string };
}

export interface PermissionAnswerDeps {
  /** Answer the parked ACP request (`answerPermission`); throws when it cannot. */
  answer(sessionId: string, requestSeq: number, optionId: string, answeredBy: PermissionAnswerer): Promise<void>;
  /** Say something in the room, as the agent's notice. */
  say(body: string): Promise<unknown>;
  /** Send the structured receipt that closes the card. Optional: without it only the prose is said. */
  sendOutcome?(content: Record<string, unknown>): Promise<unknown>;
  /** The person's label for a receipt; never an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  now?(): Date;
}

const TEXT: Record<Exclude<PermissionAnswerRefusal, "not-an-answer" | "reference-mismatch" | "agent-refused">, string> = {
  "unknown-request": "That is not a permission request this room is waiting on. Nothing was sent to the agent.",
  "other-session": "That permission request belongs to an earlier session, so it can no longer be answered. Nothing was sent to the agent.",
  "subject-missing": "That answer did not say which request it answers. Nothing was sent to the agent.",
  "subject-mismatch": "That answer was for a different request than the one this room asked. Nothing was sent to the agent.",
  "bad-option": "That is not one of this request's options. Nothing was sent to the agent.",
  "not-pending": "That permission request was already settled. Nothing was sent to the agent.",
  expired: "That permission request has expired, so it can no longer be answered. Nothing was sent to the agent.",
  "preview-incomplete":
    "The card could not show everything this would allow, so it cannot be allowed from here. Answer it in the console. Nothing was sent to the agent.",
};

/** The judgement, pure: what the record says about this answer. */
export function permissionRefusal(
  parsed: ParsedPermissionAnswer,
  record: PermissionRecord | null,
  ctx: Pick<PermissionAnswerContext, "roomId" | "sessionId">,
  now: Date,
): PermissionAnswerRefusal | null {
  if (!record || record.roomId !== ctx.roomId) return "unknown-request";
  // Both the id and the reference, checked against each other, the way a gate decision is.
  if (record.eventId === null || parsed.referencedEventId !== record.eventId) return "reference-mismatch";
  if (record.sessionId !== ctx.sessionId) return "other-session";
  if (!parsed.subject) return "subject-missing";
  if (parsed.subject.id !== record.requestId || parsed.subject.digest !== record.digest) return "subject-mismatch";
  const option = record.options.find((o) => o.id === parsed.optionId);
  if (!option) return "bad-option";
  if (record.status !== "pending") return "not-pending";
  if (now.getTime() >= record.expiresAt.getTime()) return "expired";
  if (option.meaning === "approve" && !record.previewComplete) return "preview-incomplete";
  return null;
}

/** Act on a permission.answer.v2, or refuse and say why. */
export async function handlePermissionAnswer(
  parsed: ParsedPermissionAnswer,
  ctx: PermissionAnswerContext,
  deps: PermissionAnswerDeps,
): Promise<PermissionAnswerOutcome> {
  const record = await permissionRecord(parsed.requestId);
  const refused = permissionRefusal(parsed, record, ctx, deps.now?.() ?? new Date());
  if (refused || !record) {
    const reason = refused === null || refused === "not-an-answer" || refused === "agent-refused" ? "unknown-request" : refused;
    log.warn("a permission.answer.v2 was refused", { requestId: parsed.requestId, optionId: parsed.optionId, reason });
    // A reference that is not the request's message is refused silently, as for a gate: an event
    // quoted from elsewhere must not make the agent speak.
    if (reason !== "reference-mismatch") await deps.say(TEXT[reason]);
    return { status: "refused", reason };
  }
  return deliver(record, parsed.optionId, ctx, deps);
}

/**
 * Hand the answer to the agent, then close the record and the card. The ACP call is the arbiter of
 * a race — it deletes the parked request synchronously — so it goes first, and a refusal there
 * (answered in the console a moment ago) is said as a late answer.
 */
async function deliver(
  record: PermissionRecord,
  optionId: string,
  ctx: PermissionAnswerContext,
  deps: PermissionAnswerDeps,
): Promise<PermissionAnswerOutcome> {
  try {
    await deps.answer(record.sessionId, record.requestSeq, optionId, {
      via: "room",
      principalId: ctx.answerer.principalId,
      mxid: ctx.answerer.mxid,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("a permission answer from a room was refused by the session", { requestId: record.requestId, error: reason });
    await deps.say(
      reason.includes("No pending permission request") ? TEXT["not-pending"] : `I could not record that answer: ${reason}`,
    );
    return { status: "refused", reason: "agent-refused" };
  }
  clearIfPending(record);
  await closeWithOutcome(record, "selected", optionId, ctx.answerer, deps);
  return { status: "answered", requestId: record.requestId };
}

/** Drop the in-memory pending request when it is this one. */
function clearIfPending(record: Pick<PermissionRecord, "roomId" | "sessionId" | "requestSeq">): void {
  const waiting = pendingPermissionFor(record.roomId);
  if (waiting && waiting.sessionId === record.sessionId && waiting.requestSeq === record.requestSeq) {
    clearPendingPermission(record.roomId);
  }
}

/** Close the record once, then say so in the room: the prose line and the structured receipt. */
async function closeWithOutcome(
  record: PermissionRecord,
  outcome: PermissionOutcome,
  optionId: string | null,
  answerer: { principalId: string; mxid: string } | null,
  deps: Pick<PermissionAnswerDeps, "say" | "sendOutcome" | "displayNameFor">,
): Promise<void> {
  const status = outcome === "selected" ? "answered" : outcome;
  const closed = await closePermission(record.requestId, {
    status,
    ...(optionId ? { optionId } : {}),
    principalId: answerer?.principalId ?? null,
    mxid: answerer?.mxid ?? null,
  });
  if (!closed || record.eventId === null) return;
  try {
    const who = answerer ? ((await deps.displayNameFor?.(answerer.principalId)) ?? null) : null;
    const label = optionId ? (record.options.find((o) => o.id === optionId)?.label ?? optionId) : null;
    await deps.say(permissionOutcomeText(outcome, label, who));
    await deps.sendOutcome?.(
      permissionOutcomeContent({ ...record, eventId: record.eventId }, outcome, optionId, who),
    );
  } catch (err) {
    log.warn("a permission closed but its receipt could not be posted", {
      requestId: record.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A typed reply to the request the room holds in memory. Judged against the durable record when
 * there is one — a request that expired or was settled is refused, never answered — and the answer
 * records who gave it. Returns null when the typed path should carry on as it always has (no
 * record: a request projected before this existed).
 */
export async function typedPermissionGate(
  waiting: { sessionId: string; requestSeq: number },
  roomId: string,
  deps: Pick<PermissionAnswerDeps, "say" | "now">,
): Promise<PermissionRecord | "refused" | null> {
  const record = await permissionRecord(permissionRequestId(waiting.sessionId, waiting.requestSeq));
  if (!record || record.roomId !== roomId) return null;
  const now = deps.now?.() ?? new Date();
  if (record.status === "pending" && now.getTime() < record.expiresAt.getTime()) return record;
  clearPendingPermission(roomId);
  await deps.say(record.status === "pending" ? TEXT.expired : TEXT["not-pending"]);
  return "refused";
}

/** After a typed answer the session accepted: close the record and the card, naming who answered. */
export async function closeTypedPermission(
  record: PermissionRecord,
  optionId: string,
  answerer: { principalId: string; mxid: string },
  deps: Pick<PermissionAnswerDeps, "say" | "sendOutcome" | "displayNameFor">,
): Promise<void> {
  await closeWithOutcome(record, "selected", optionId, answerer, deps);
}

/**
 * A reply when the room holds no request in memory: is it a late answer to the last one? True —
 * said in the room, and the caller must NOT prompt the agent with it — when the room's newest
 * request was closed within the answer window (or is still marked pending though nothing is parked,
 * as after a restart), and the reply is exactly one of its options by number, name or id. Anything
 * else is an ordinary message.
 */
export async function refuseLatePermissionReply(
  roomId: string,
  text: string,
  deps: Pick<PermissionAnswerDeps, "say" | "now">,
): Promise<boolean> {
  const latest = await latestPermissionInRoom(roomId);
  if (!latest || !withinLateWindow(latest, (deps.now?.() ?? new Date()).getTime())) return false;
  const matched = matchPermissionAnswer(text, latest.options.map((o) => ({ optionId: o.id, name: o.label })));
  if (matched === null) return false;
  // The person has talked to the agent since: a number now answers whatever the agent said last.
  if (await promptedSince(latest.sessionId, latest.requestSeq)) return false;
  log.info("a late reply to a closed permission request was not passed to the agent", { roomId, requestId: latest.requestId });
  await deps.say(latest.status === "pending" || latest.status === "expired" ? TEXT.expired : TEXT["not-pending"]);
  return true;
}

/** How long after an answer elsewhere (the console, a tap) a matching reply still reads as late. */
const LATE_AFTER_ANSWER_MS = 2 * 60_000;

/**
 * Is a reply now still plausibly an answer to this request? An expired request: for one more answer
 * window. One answered or withdrawn: for two minutes — the double-answer case. One still marked
 * pending with nothing parked (the hub restarted under it): until it would have expired, plus a
 * window.
 */
function withinLateWindow(r: PermissionRecord, now: number): boolean {
  if (r.status === "pending") return now < r.expiresAt.getTime() + PERMISSION_TTL_MS;
  const closed = r.closedAt?.getTime() ?? 0;
  return now - closed < (r.status === "expired" ? PERMISSION_TTL_MS : LATE_AFTER_ANSWER_MS);
}

export interface PermissionExpiryDeps {
  /** Release the parked ACP request with `cancelled`; false when nothing was parked. */
  cancel(record: PermissionRecord): Promise<boolean>;
  /** Say a line in the request's room, as its agent. */
  say(roomId: string, body: string): Promise<unknown>;
  sendOutcome?(roomId: string, content: Record<string, unknown>): Promise<unknown>;
  now?(): Date;
}

/**
 * Expire every request whose time is up: the agent is answered `cancelled` — it was not given
 * permission, and is not left parked for ever — and the card is closed with an `expired` outcome.
 * Claimed per request, so an answer racing the sweep leaves one outcome.
 */
export async function expirePermissions(deps: PermissionExpiryDeps): Promise<number> {
  const due = await expiredPendingPermissions(deps.now?.() ?? new Date());
  let expired = 0;
  for (const record of due) {
    const scoped = {
      say: (body: string) => deps.say(record.roomId, body),
      ...(deps.sendOutcome ? { sendOutcome: sendIn(deps, record.roomId) } : {}),
    };
    // Claimed first: if an answer got there in the same instant, it owns the outcome.
    if (!(await claimExpiry(record))) continue;
    clearIfPending(record);
    try {
      await deps.cancel(record);
    } catch (err) {
      log.warn("an expired permission request could not be released", {
        requestId: record.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await postExpiry(record, scoped);
    expired++;
  }
  return expired;
}

/** A room-addressed send, bound to one room. */
function sendIn(deps: Pick<PermissionExpiryDeps, "sendOutcome">, roomId: string): (content: Record<string, unknown>) => Promise<unknown> {
  return async (content) => deps.sendOutcome?.(roomId, content);
}

async function claimExpiry(record: PermissionRecord): Promise<boolean> {
  return closePermission(record.requestId, { status: "expired" });
}

async function postExpiry(record: PermissionRecord, deps: Pick<PermissionAnswerDeps, "say" | "sendOutcome">): Promise<void> {
  if (record.eventId === null) return;
  try {
    await deps.say(permissionOutcomeText("expired", null, null));
    await deps.sendOutcome?.(permissionOutcomeContent({ ...record, eventId: record.eventId }, "expired", null, null));
  } catch (err) {
    log.warn("an expired permission's receipt could not be posted", {
      requestId: record.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
