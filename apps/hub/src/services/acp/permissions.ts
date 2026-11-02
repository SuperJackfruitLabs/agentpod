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
  return new Promise<RequestPermissionResponse>((resolve) => {
    live.pending.set(requestSeq, resolve);
  });
}

export async function answerPermission(
  userId: string,
  sessionId: string,
  requestSeq: number,
  optionId: string,
): Promise<void> {
  const live = requireLive(userId, sessionId);
  const resolve = live.pending.get(requestSeq);
  if (!resolve) throw new Error("No pending permission request.");
  live.pending.delete(requestSeq);
  const { done: answerWritten } = persistEvent(live, "permission-answer", {
    requestSeq,
    optionId,
  });
  const { done: statusWritten } = setStatus(live, "working");
  resolve({ outcome: { outcome: "selected", optionId } });
  await Promise.all([answerWritten, statusWritten]);
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
