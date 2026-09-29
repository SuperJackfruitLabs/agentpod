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
 *
 * `quiet` is an event the hub posts that must never reach a phone as a push:
 * its own reactions (👀/✅/❌) and a turn's activity record
 * (`dev.agentpod.turn.v1`). The app's extension decrypts those and blanks
 * them, but without Apple's filtering entitlement iOS still shows the empty
 * push — so the gateway must not send one. Noted by `matrix-as/push-quiet.ts`,
 * which wraps the client every agent speaks through.
 *
 * For `quiet` the race above is not left to chance. A quiet send is announced
 * per room BEFORE it is made (`beginQuietSend`), and a push for an unknown
 * event in a room with a quiet send in flight waits — bounded — for that send
 * to return its id (`quietSendsSettled`). A room with nothing in flight waits
 * for nothing, so an ordinary message is never held.
 */

export type HubEventKind = "permission" | "gate" | "companion" | "quiet" | "answer";

/**
 * A finished turn's outcome, as counts. Noted on the `answer` that ended the
 * turn so the gateway can put it on that push (spec A5) — counts only, never
 * a tool's title or anything it said.
 */
export interface TurnCounts {
  total: number;
  failed: number;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5_000;

const kinds = new Map<string, { kind: HubEventKind; until: number; turn?: TurnCounts }>();

export function noteHubEvent(eventId: string | null | undefined, kind: HubEventKind, now = Date.now()): void {
  note(eventId, kind, undefined, now);
}

/**
 * `answer` is the agent's reply that ended a turn which ran tools. It still
 * pushes as an ordinary message; the gateway adds `turn` to it. Announced
 * in flight by `outbound.ts` like a quiet send, so a push that beats the
 * send's response waits for the counts rather than going without them.
 */
export function noteAnswerEvent(eventId: string | null | undefined, turn: TurnCounts, now = Date.now()): void {
  note(eventId, "answer", { total: turn.total, failed: turn.failed }, now);
}

function note(eventId: string | null | undefined, kind: HubEventKind, turn: TurnCounts | undefined, now: number): void {
  if (!eventId) return;
  // Re-inserted so Map order stays oldest-first for eviction.
  kinds.delete(eventId);
  kinds.set(eventId, { kind, until: now + TTL_MS, ...(turn ? { turn } : {}) });
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

/** The counts noted with an `answer`, or undefined for anything else. */
export function hubEventTurn(eventId: string | undefined, now = Date.now()): TurnCounts | undefined {
  if (!eventId || hubEventKind(eventId, now) === undefined) return undefined;
  return kinds.get(eventId)?.turn;
}

// ─── Quiet sends in flight ───────────────────────────────────────────────────

/** roomId → how many quiet sends into it have started and not yet returned. */
const inFlight = new Map<string, number>();
/** roomId → callbacks to run whenever a quiet send into it returns. */
const listeners = new Map<string, Set<() => void>>();

/**
 * Announce a quiet send into `roomId` before making it. Returns the call that
 * ends it — run it once the send has returned AND its id has been noted, or
 * has failed. Calling it more than once is harmless.
 */
export function beginQuietSend(roomId: string): () => void {
  inFlight.set(roomId, (inFlight.get(roomId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (inFlight.get(roomId) ?? 1) - 1;
    if (left > 0) inFlight.set(roomId, left);
    else inFlight.delete(roomId);
    for (const wake of [...(listeners.get(roomId) ?? [])]) wake();
  };
}

export function quietSendsInFlight(roomId: string | undefined): number {
  return roomId ? (inFlight.get(roomId) ?? 0) : 0;
}

/**
 * Wait until `eventId` is known, or no quiet send into `roomId` is in flight,
 * or `timeoutMs` passes — whichever is first. Resolves at once when the room
 * has nothing in flight.
 */
export function quietSendsSettled(
  roomId: string | undefined,
  eventId: string | undefined,
  timeoutMs: number
): Promise<void> {
  if (!roomId || quietSendsInFlight(roomId) === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let set = listeners.get(roomId);
    if (!set) listeners.set(roomId, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      const s = listeners.get(roomId);
      s?.delete(check);
      if (s && s.size === 0) listeners.delete(roomId);
      resolve();
    };
    const check = () => {
      if (hubEventKind(eventId) !== undefined || quietSendsInFlight(roomId) === 0) done();
    };
    const timer = setTimeout(done, timeoutMs);
    set.add(check);
  });
}

export function _resetHubEventsForTest(): void {
  kinds.clear();
  inFlight.clear();
  listeners.clear();
}

/** How many pushes are waiting on `roomId` — a barrier for tests, never a sleep. */
export function _quietWaitersForTest(roomId: string): number {
  return listeners.get(roomId)?.size ?? 0;
}

export function _hubEventCountForTest(): number {
  return kinds.size;
}
