/** Whether a live session can take a prompt now, and waiting until it can. */

import { subscribe } from "./events";
import { liveById } from "./session-state";

/** What `promptSession` throws for a session still in a turn. Matched, not parsed. */
export const SESSION_BUSY_MESSAGE =
  "Session is busy — wait for the current turn to finish.";

/**
 * Whether a live session is mid-turn. A session that is not live — ended, or
 * never opened on this hub — is not busy: prompting it creates or fails, it
 * does not wait.
 */
export function sessionIsBusy(sessionId: string): boolean {
  const live = liveById.get(sessionId);
  return !!live && !live.ended && live.status !== "idle";
}

/**
 * Resolve when the session can take a prompt ("idle"), can no longer answer
 * ("ended"), or has been working for `timeoutMs` ("timeout").
 *
 * Built on the same event fan-out the console and the rooms listen to, so it
 * cannot disagree with them about when a turn ended.
 */
export function whenIdle(
  sessionId: string,
  timeoutMs = 15 * 60_000,
): Promise<"idle" | "ended" | "timeout"> {
  const live = liveById.get(sessionId);
  if (!live || live.ended) return Promise.resolve("ended");
  if (live.status === "idle") return Promise.resolve("idle");
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: "idle" | "ended" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = subscribe(sessionId, (event) => {
      if (event.type !== "state") return;
      const status = (event.payload as { status?: string } | undefined)?.status;
      if (status === "idle") finish("idle");
      else if (status === "ended") finish("ended");
    });
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}
