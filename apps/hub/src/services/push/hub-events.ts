/**
 * Which room events the hub itself posted as questions.
 *
 * The push gateway is told an event id and nothing else (`event_id_only`), so
 * the only way it can mark a push "this is a question" is to remember the ids
 * of the questions this process asked. The senders — `outbound.ts` for a
 * permission request, `gates.ts` for a superpipeline gate — note each id as the
 * homeserver hands it back.
 *
 * `companion` is the legacy custom event sent beside a question's prose
 * message while `AGENTPOD_LEGACY_PERMISSION_EVENTS` is on. In an encrypted room
 * both events are `m.room.encrypted` and both match the push rules, so without
 * this the phone would buzz twice for one question. The gateway drops a push
 * for a companion. It is noted only after its prose message landed, so a
 * question whose prose failed still reaches the phone through the companion.
 *
 * In memory, deliberately. A push follows its event by milliseconds to
 * seconds, so a record that outlives the process buys nothing; the bound and
 * the TTL keep a long-lived hub from growing a map of every question it ever
 * asked. A restart between a send and its push costs one untagged push.
 *
 * Best effort, and says so: the homeserver may fan the push out before the
 * send's response reaches this process, in which case that one push goes
 * untagged (or, for a companion, is sent). Nothing breaks either way.
 */

export type HubEventKind = "permission" | "gate" | "companion";

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5_000;

const kinds = new Map<string, { kind: HubEventKind; until: number }>();

export function noteHubEvent(eventId: string | null | undefined, kind: HubEventKind, now = Date.now()): void {
  if (!eventId) return;
  // Re-inserted so Map order stays oldest-first for eviction.
  kinds.delete(eventId);
  kinds.set(eventId, { kind, until: now + TTL_MS });
  while (kinds.size > MAX_ENTRIES) {
    const oldest = kinds.keys().next().value;
    if (oldest === undefined) break;
    kinds.delete(oldest);
  }
}

export function hubEventKind(eventId: string | undefined, now = Date.now()): HubEventKind | undefined {
  if (!eventId) return undefined;
  const entry = kinds.get(eventId);
  if (!entry) return undefined;
  if (entry.until <= now) {
    kinds.delete(eventId);
    return undefined;
  }
  return entry.kind;
}

export function _resetHubEventsForTest(): void {
  kinds.clear();
}

export function _hubEventCountForTest(): number {
  return kinds.size;
}
