/**
 * Permission modes (ask / accept-edits / full-auto) applied to the agent's
 * `session/request_permission`, the answer to a parked request, and the mode switch.
 */

import { and, eq } from "drizzle-orm";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AcpSessionMode } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { persistEvent, setStatus } from "./events";
import { liveById, requireLive, type LiveSession } from "./session-state";

export function handlePermissionRequest(
  live: LiveSession,
  params: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  if (live.ended) {
    return Promise.resolve({ outcome: { outcome: "cancelled" } });
  }

  const autoAllow =
    live.mode === "full-auto" ||
    (live.mode === "accept-edits" && params.toolCall.kind === "edit");

  if (autoAllow) {
    const option =
      params.options.find(
        (o) => o.kind === "allow_once" || o.kind === "allow_always",
      ) ?? params.options[0];
    const { seq: requestSeq } = persistEvent(live, "permission-request", {
      toolCall: params.toolCall,
      options: params.options,
      auto: true,
    });
    if (!option) {
      persistEvent(live, "permission-answer", {
        requestSeq,
        cancelled: true,
        auto: true,
      });
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    persistEvent(live, "permission-answer", {
      requestSeq,
      optionId: option.optionId,
      auto: true,
    });
    return Promise.resolve({
      outcome: { outcome: "selected", optionId: option.optionId },
    });
  }

  // ask (or accept-edits falling through): park until answerPermission.
  const { seq: requestSeq } = persistEvent(live, "permission-request", {
    toolCall: params.toolCall,
    options: params.options,
  });
  setStatus(live, "waiting");
  const optionIds = params.options.map((o) => o.optionId);
  return new Promise<RequestPermissionResponse>((resolve) => {
    live.pending.set(requestSeq, { resolve, optionIds });
  });
}

/**
 * Who answered a permission request, recorded on its `permission-answer` event (charter: strict
 * decisions and harness permissions bind their subject §6). `via` is the surface; the ids are what
 * that surface knows — a room knows the person's principal and Matrix id, the console its user.
 */
export interface PermissionAnswerer {
  via: "room" | "console" | "board" | "editor";
  principalId?: string | null;
  userId?: string | null;
  mxid?: string | null;
}

/** Thrown when an answer names an option the request did not offer. */
export const OPTION_NOT_OFFERED_MESSAGE = "That option was not offered for this permission request.";

export async function answerPermission(
  userId: string,
  sessionId: string,
  requestSeq: number,
  optionId: string,
  answeredBy?: PermissionAnswerer,
): Promise<void> {
  const live = requireLive(userId, sessionId);
  const parked = live.pending.get(requestSeq);
  if (!parked) throw new Error("No pending permission request.");
  // Every surface reaches this — the console, a room, a board, an editor — so the check lives here:
  // the harness is only ever answered with an option it put on the table.
  if (!parked.optionIds.includes(optionId)) throw new Error(OPTION_NOT_OFFERED_MESSAGE);
  live.pending.delete(requestSeq);
  const { done: answerWritten } = persistEvent(live, "permission-answer", {
    requestSeq,
    optionId,
    ...(answeredBy ? { answeredBy } : {}),
  });
  const { done: statusWritten } = setStatus(live, "working");
  parked.resolve({ outcome: { outcome: "selected", optionId } });
  await Promise.all([answerWritten, statusWritten]);
}

/**
 * Release a parked request without choosing — ACP's `cancelled` outcome — because it expired
 * unanswered (the room's permission.v2 expiry). False when nothing is parked under that seq any
 * more: answered meanwhile, or the session is gone.
 */
export async function cancelPermission(
  userId: string,
  sessionId: string,
  requestSeq: number,
  reason: "expired",
): Promise<boolean> {
  const live = liveById.get(sessionId);
  if (!live || live.userId !== userId) return false;
  const parked = live.pending.get(requestSeq);
  if (!parked) return false;
  live.pending.delete(requestSeq);
  const { done: answerWritten } = persistEvent(live, "permission-answer", { requestSeq, cancelled: true, reason });
  const { done: statusWritten } = setStatus(live, "working");
  parked.resolve({ outcome: { outcome: "cancelled" } });
  await Promise.all([answerWritten, statusWritten]);
  return true;
}

export async function setMode(
  userId: string,
  sessionId: string,
  mode: AcpSessionMode,
): Promise<void> {
  const live = liveById.get(sessionId);
  if (live && live.userId !== userId) throw new Error("Session not found.");
  const rows = await db
    .update(acpSessions)
    .set({ mode })
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)))
    .returning({ id: acpSessions.id });
  if (rows.length === 0) throw new Error("Session not found.");
  if (live) live.mode = mode;
}
