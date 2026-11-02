/** The agent's `session/update` notifications, and the Salaam receipts they carry. */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import { SalaamCancellationReceipt, SalaamPromptReceipt } from "@agentpod/contract";
import {
  getSalaamPrompt,
  readSalaamCancellation,
  updateSalaamPrompt,
  type SalaamCancellationState,
} from "../salaam";
import { enqueue, persistEvent, setStatus } from "./events";
import type { LiveSession } from "./session-state";

// ─── SDK callbacks ───────────────────────────────────────────────────────────

export function handleSessionUpdate(
  live: LiveSession,
  params: SessionNotification,
): void {
  if (live.ended) return;
  if (handledAsSalaamReceipt(live, params)) return;
  // `session_info` can rename the session but leaves the chat empty. Only mark
  // a turn productive when the console has an agent update to render.
  const update = params.update as { sessionUpdate?: unknown };
  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk" ||
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update"
  ) {
    live.turnProduced = true;
    live.lastProducedAt = Date.now();
  }
  const meta = (params.update as { _meta?: unknown })._meta;
  if (meta && typeof meta === "object") {
    const key = (meta as { sessionKey?: unknown }).sessionKey;
    if (typeof key === "string" && key !== "") live.harnessSessionKey = key;
  }
  // Every SDK sessionUpdate notification → agent-update with the raw update.
  persistEvent(live, "agent-update", params.update);
}

/**
 * A Salaam session's update can be a cancellation or prompt receipt, applied in the session's
 * write queue, or a replayed user message the hub already saved. True when it was one of those.
 */
function handledAsSalaamReceipt(live: LiveSession, params: SessionNotification): boolean {
  if (!live.executionAuthority) return false;
  const cancellation = (params.update as { _meta?: Record<string, unknown> })
    ._meta?.["salaam.dev/cancellationReceipt"];
  if (cancellation) {
    const parsed = SalaamCancellationReceipt.safeParse(cancellation);
    if (
      parsed.success &&
      parsed.data.sessionId === live.executionAuthority.sessionId &&
      parsed.data.targetRequestId
    )
      applyCancellationReceipt(live, parsed.data);
    return true;
  }
  const raw = (params.update as { _meta?: Record<string, unknown> })._meta?.[
    "salaam.dev/promptReceipt"
  ];
  if (raw) {
    const parsed = SalaamPromptReceipt.safeParse(raw);
    if (
      parsed.success &&
      parsed.data.sessionId === live.executionAuthority.sessionId &&
      parsed.data.attemptId
    )
      applyPromptReceipt(live, parsed.data, parsed.data.attemptId);
    return true;
  }
  // The Hub already saved the logical user event before dispatch. ACP load replays it.
  return params.update.sessionUpdate === "user_message_chunk";
}

/** A cancellation receipt for this session: settle the saved intent and the session's status. */
function applyCancellationReceipt(live: LiveSession, receipt: SalaamCancellationReceipt): void {
  void enqueue(live, async () => {
    const saved = await readSalaamCancellation(
      live.id,
      receipt.requestId,
    );
    if (
      !saved ||
      saved.targetRequestId !== receipt.targetRequestId ||
      saved.state === "confirmed"
    )
      return;
    const prompt = await getSalaamPrompt(
      live.userId,
      live.id,
      receipt.targetRequestId!,
    );
    if (
      prompt.attemptId &&
      !receipt.attemptIds.includes(prompt.attemptId)
    )
      return;
    const current = await readSalaamCancellation(live.id);
    const applies =
      current?.requestId === receipt.requestId &&
      (!live.logicalPromptInFlight ||
        live.logicalPromptInFlight === receipt.targetRequestId);
    if (receipt.state === "confirmed")
      await updateSalaamPrompt(
        live.id,
        receipt.targetRequestId!,
        "interrupted",
      );
    if (applies)
      live.pendingCancellation = receipt as SalaamCancellationState;
    const status = applies
      ? receipt.state === "confirmed"
        ? "idle"
        : live.turnInFlight && receipt.state === "requested"
          ? "working"
          : "waiting"
      : live.status;
    // State writes queue after this item; never await our own queue.
    setStatus(live, status, {
      extra: { cancellation: receipt },
      force: true,
    });
  });
}

/** A prompt receipt for this session: record it, and append it as a state event. */
function applyPromptReceipt(live: LiveSession, data: SalaamPromptReceipt, attemptId: string): void {
  const { requestId, state } = data;
  void enqueue(live, async () => {
    const receipt = await updateSalaamPrompt(
      live.id,
      requestId,
      state,
      attemptId,
    );
    // Append after this queue item; do not await a write queued behind itself.
    persistEvent(live, "state", {
      status: live.status,
      promptReceipt: receipt,
    });
  });
}
