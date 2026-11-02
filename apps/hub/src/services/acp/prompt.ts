/** `promptSession`: a turn's prompt, bound to a Salaam request id when the session has one. */

import { and, eq } from "drizzle-orm";
import type { SalaamPromptReceipt, SalaamRunAuthority } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import type { PromptImage } from "../matrix";
import { bindSalaamPrompt, getSalaamPrompt } from "../salaam";
import { restoreSalaamRow, turnDeps } from "./recovery";
import { liveById, requireLive } from "./session-state";
import { withStationOpenLock } from "./timing";
import { dispatchPrompt } from "./turn";

/**
 * Send one turn's prompt.
 *
 * `images` are the pictures that came with it — from a bridged room, today.
 * They go to the agent as ACP image blocks when it accepts them, and as a
 * note in the text when it does not. The transcript records each image's
 * name, type and size, never its bytes: `acp_events` is a log, not a store
 * of everything anyone ever sent an agent.
 */
export function promptSession(
  userId: string,
  sessionId: string,
  text: string,
  images?: PromptImage[],
  executionRun?: SalaamRunAuthority,
): Promise<void>;
export function promptSession(
  userId: string,
  sessionId: string,
  text: string,
  images: PromptImage[],
  executionRun: SalaamRunAuthority | undefined,
  requestId: string | undefined,
): Promise<void | SalaamPromptReceipt>;
export async function promptSession(
  userId: string,
  sessionId: string,
  text: string,
  images: PromptImage[] = [],
  executionRun?: SalaamRunAuthority,
  requestId?: string,
): Promise<void | SalaamPromptReceipt> {
  return withStationOpenLock("prompt:" + sessionId, async () => {
    const [row] = await db
      .select()
      .from(acpSessions)
      .where(
        and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)),
      );
    if (!row) throw Error("Session not found");
    if (!row.executionAuthority)
      return dispatchPrompt(turnDeps, userId, sessionId, text, images, executionRun);
    if (images.length) throw Error("Salaam image prompts are not enabled");
    const bound = await bindSalaamPrompt(
      userId,
      sessionId,
      requestId ?? crypto.randomUUID(),
      text,
    );
    const id = bound.receipt.requestId;
    if (["accepted", "completed", "interrupted"].includes(bound.receipt.state))
      return bound.receipt;
    if (!liveById.has(sessionId) && row.status !== "ended")
      await restoreSalaamRow(row);
    const live = requireLive(userId, sessionId);
    if (
      live.logicalPromptInFlight === id ||
      (!bound.fresh && live.status !== "idle")
    )
      return bound.receipt;
    await dispatchPrompt(turnDeps, userId, sessionId, text, [], executionRun, id);
    return getSalaamPrompt(userId, sessionId, id);
  });
}
