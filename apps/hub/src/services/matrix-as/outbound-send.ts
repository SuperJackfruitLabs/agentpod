/** Sending into the room: a message, and an edit of one. Both report failure as null. */

import { beginQuietSend, noteHubEvent } from "../push";
import { log } from "./outbound-log";
import type { RoomContext } from "./outbound-state";

/** Sends into the room. Returns the event id, or null when it did not land. */
export async function say(ctx: RoomContext, body: string, extra?: Record<string, unknown>): Promise<string | null> {
  const { sessionId, roomId, agentUser, deps } = ctx;
  try {
    return await deps.client.sendText(agentUser, roomId, body, extra);
  } catch (err) {
    // A homeserver hiccup must not silently detach the room: the next turn
    // should still arrive. Losing one message loudly beats losing the
    // conversation quietly.
    log.error("could not send an agent message into its room", {
      sessionId,
      roomId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Replace an open message's text with `full`: an `m.replace` edit through
 * the same `say` (and so the same encrypted path) as the original. Quiet —
 * the original already buzzed the phone; its edit must not buzz again.
 */
export async function edit(ctx: RoomContext, eventId: string, full: string): Promise<string | null> {
  const { roomId } = ctx;
  const end = beginQuietSend(roomId);
  try {
    const id = await say(ctx, `* ${full}`, {
      "m.new_content": { msgtype: "m.text", body: full },
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    });
    noteHubEvent(id, "quiet");
    return id;
  } finally {
    end();
  }
}
