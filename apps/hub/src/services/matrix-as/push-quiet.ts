/**
 * Keeping the hub's own bookkeeping events off the phone.
 *
 * The hub posts events into rooms that are not messages: a reaction on the
 * user's message (👀 working, ✅ done, ❌ failed) and a turn's activity record
 * (`dev.agentpod.turn.v1`). In an encrypted room the activity record is
 * `m.room.encrypted` and matches `.m.rule.encrypted`, so the homeserver pushes
 * it; the app's extension decrypts it, finds nothing to show and blanks it —
 * and iOS, without Apple's filtering entitlement, shows the empty push anyway
 * (reported on TestFlight build 30, 2026-09-28).
 *
 * The gateway is told only an event id (`event_id_only`), so it can only drop
 * those pushes if this process remembers which ids were quiet. A decorator on
 * the client every agent speaks through, like `withEncryption`, so a new send
 * site cannot forget: each quiet send is announced for its room before it is
 * made — the push can race the send's response — and its id noted as `quiet`
 * when it lands. See `push/hub-events.ts` for how the gateway uses both.
 *
 * Deliberately NOT quiet:
 * - `sendText` — every text is something a person should be told about.
 * - the legacy permission/gate companion events — `outbound.ts`/`gates.ts`
 *   note those as `companion` only once their prose landed, so a question
 *   whose prose failed still reaches the phone.
 * - `redact` — a redaction is never encrypted and matches no default push
 *   rule; against tuwunel 1.9.3 not one of 50 pushed (2026-09-28). It returns
 *   no event id to note, either.
 *
 * The same measurement found the hub's plaintext reactions do not push under
 * tuwunel's default rules either. They are noted anyway: a user's own push
 * rules, or a hub that one day encrypts them, would make them push, and noting
 * costs nothing.
 */

import type { MatrixClient } from "./client";
import { TURN_ACTIVITY_TYPE } from "./activity";
import { beginQuietSend, noteHubEvent } from "../push/hub-events";

/** Custom event types the hub sends that must never push. */
export const QUIET_EVENT_TYPES: ReadonlySet<string> = new Set([TURN_ACTIVITY_TYPE]);

async function quietly(roomId: string, send: () => Promise<string | null>): Promise<string | null> {
  const end = beginQuietSend(roomId);
  try {
    const id = await send();
    noteHubEvent(id, "quiet");
    return id;
  } finally {
    end();
  }
}

export function withQuietNotes(client: MatrixClient): MatrixClient {
  return {
    ...client,
    sendReaction(userId, roomId, targetEventId, key) {
      return quietly(roomId, () => client.sendReaction(userId, roomId, targetEventId, key));
    },
    sendCustomEvent(userId, roomId, eventType, content) {
      if (!QUIET_EVENT_TYPES.has(eventType)) {
        return client.sendCustomEvent(userId, roomId, eventType, content);
      }
      return quietly(roomId, () => client.sendCustomEvent(userId, roomId, eventType, content));
    },
  };
}
