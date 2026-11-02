/** What the room shows without a message: typing, the mark on the message, and an error notice. */

import { TURN_ERROR_CONTENT_KEY } from "@agentpod/contract";
import { turnErrorCard } from "../acp";
import { errorMessage } from "./outbound-payloads";
import { say } from "./outbound-send";
import { REACTION, type RoomContext } from "./outbound-state";

export async function stopTyping(ctx: RoomContext): Promise<void> {
  const { roomId, agentUser, deps, state } = ctx;
  if (state.typingTimer) {
    clearInterval(state.typingTimer);
    state.typingTimer = null;
  }
  await deps.client.sendTyping(agentUser, roomId, false).catch(() => {});
}

export async function startTyping(ctx: RoomContext): Promise<void> {
  const { roomId, agentUser, deps, state } = ctx;
  await deps.client.sendTyping(agentUser, roomId, true).catch(() => {});
  if (state.typingTimer) clearInterval(state.typingTimer);
  // Renewed rather than set once: the notice expires on its own, and a long
  // turn would otherwise look abandoned halfway through.
  state.typingTimer = setInterval(() => {
    void deps.client.sendTyping(agentUser, roomId, true).catch(() => {});
  }, ctx.typingRefreshMs);
}

/** Put a mark on the message that started this turn, replacing any earlier one. */
export async function mark(ctx: RoomContext, key: string): Promise<void> {
  const { roomId, agentUser, deps, state } = ctx;
  const target = state.triggerEventId;
  if (!target || !deps.client.sendReaction) return;

  // Two marks on one message would read as two states at once, so the
  // previous one is taken off before the next goes on.
  if (state.workingReactionId && deps.client.redact) {
    await deps.client.redact(agentUser, roomId, state.workingReactionId).catch(() => {});
    state.workingReactionId = null;
  }

  const id = await deps.client
    .sendReaction(agentUser, roomId, target, key)
    .catch(() => null);
  if (key === REACTION.working) state.workingReactionId = id ?? null;
}

/** Post the held error as the turn's outcome: ❌ on the message and the notice. */
export async function reportError(ctx: RoomContext): Promise<void> {
  const { state } = ctx;
  const payload = state.pendingError;
  state.pendingError = null;
  // The error path explains itself; the silence check must not repeat the
  // same news less specifically.
  state.reportedError = true;
  await stopTyping(ctx);
  await mark(ctx, REACTION.failed);
  // A client that knows the key draws a card from it: what failed, which
  // model, each fallback. Every other client shows the body.
  const card = turnErrorCard(payload);
  await say(ctx,
    `This agent reported an error: ${errorMessage(payload)}`,
    card ? { [TURN_ERROR_CONTENT_KEY]: card } : undefined
  );
}
