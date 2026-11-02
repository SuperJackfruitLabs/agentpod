/**
 * The session's event log: every event gets the next seq in memory, is written to `acp_events`
 * (with the row's activity columns) through the session's serialized write queue, and is fanned
 * out to live subscribers. Status transitions are `state` events.
 */

import { eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { AcpEvent, AcpEventType, AcpSessionStatus } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { acpEvents, acpSessions } from "../../db/schema/acp";
import { log } from "./log";
import type { LiveSession } from "./session-state";

const subscribers = new Map<string, Set<(e: AcpEvent) => void>>();

/** Columns a row write may set alongside the ones persistEvent owns. */
type SessionRowPatch = PgUpdateSetSource<typeof acpSessions>;

// ─── Event persistence ────────────────────────────────────────────────────────

function fanOut(sessionId: string, event: AcpEvent): void {
  const set = subscribers.get(sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch (err) {
      log.error("ACP subscriber threw", { sessionId, error: String(err) });
    }
  }
}

/** Chain work onto the session's serialized write queue. */
export function enqueue(live: LiveSession, fn: () => Promise<void>): Promise<void> {
  const p = live.chain.then(fn);
  live.chain = p.catch((err) => {
    log.error("ACP event write failed", {
      sessionId: live.id,
      error: String(err),
    });
  });
  return p;
}

/**
 * Persist the next event: assign seq synchronously, then (serialized) insert
 * into acp_events, bump last_event_at + last_seq (+ any extra row columns), and
 * fan out.
 *
 * last_seq rides along in the SAME update as last_event_at — a second round
 * trip would double every event's write cost and could be observed half-applied
 * (a row whose activity moved but whose transcript size didn't). Plain
 * assignment is safe because the writes are serialized per session (enqueue)
 * in seq order, so the last write always carries the highest seq.
 */
export function persistEvent(
  live: LiveSession,
  type: AcpEventType,
  payload: unknown,
  rowSet: SessionRowPatch = {},
): { seq: number; done: Promise<void> } {
  const seq = ++live.seq;
  const createdAt = new Date();
  live.lastActivityAt = createdAt.getTime();
  const done = enqueue(live, async () => {
    const inserted = await db.transaction(async (tx) => {
      const insert = tx.insert(acpEvents).values({
        sessionId: live.id,
        tenantId: live.tenantId,
        seq,
        type,
        payload: payload as object,
        createdAt,
      });
      // Only exact source/request identity duplicates are harmless. A conflicting
      // transcript sequence must still fail rather than silently losing an event.
      const data = payload as {
        _meta?: Record<string, unknown>;
        requestId?: string;
      };
      // Drizzle's column-only conflict API cannot target expression indexes.
      // Keep the insert built by the ORM, with a fixed, parameter-free target.
      const conflict =
        live.executionAuthority &&
        type === "agent-update" &&
        typeof data?._meta?.["salaam.dev/updateId"] === "string"
          ? sql`("session_id", ("payload" #>> '{_meta,salaam.dev/updateId}')) WHERE "type" = 'agent-update' AND "payload" #>> '{_meta,salaam.dev/updateId}' IS NOT NULL`
          : live.executionAuthority &&
              type === "user-prompt" &&
              typeof data?.requestId === "string"
            ? sql`("session_id", ("payload"->>'requestId')) WHERE "type" = 'user-prompt' AND "payload"->>'requestId' IS NOT NULL`
            : null;
      const rows = conflict
        ? await tx.execute<{ seq: number }>(
            sql`${insert.getSQL()} ON CONFLICT ${conflict} DO NOTHING RETURNING "seq"`,
          )
        : await insert.returning({ seq: acpEvents.seq });
      if (!rows.length) return false;
      await tx
        .update(acpSessions)
        .set({ lastEventAt: createdAt, lastSeq: seq, ...rowSet })
        .where(eq(acpSessions.id, live.id));
      return true;
    });
    if (!inserted) return;
    fanOut(live.id, {
      sessionId: live.id,
      seq,
      type,
      payload,
      createdAt: createdAt.toISOString(),
    });
  });
  return { seq, done };
}

/** Status transition: update the row and persist a `state` event. */
export function setStatus(
  live: LiveSession,
  status: AcpSessionStatus,
  opts: {
    extra?: Record<string, unknown>;
    endedReason?: string;
    endedCause?: "idle" | "admin";
    force?: boolean;
  } = {},
): { seq: number; done: Promise<void> } {
  if (live.status === status && !opts.force) {
    return { seq: live.seq, done: Promise.resolve() };
  }
  live.status = status;
  return persistEvent(
    live,
    "state",
    { status, ...(opts.extra ?? {}) },
    {
      status,
      ...(opts.endedReason !== undefined
        ? { endedReason: opts.endedReason }
        : {}),
      ...(opts.endedCause !== undefined ? { endedCause: opts.endedCause } : {}),
    },
  );
}

/**
 * Append a state-ended event (seq = MAX(seq)+1) and mark a NON-LIVE row ended.
 * Live sessions go through finalizeEnd instead (in-memory seq counter).
 */
export async function appendEndedState(
  sessionId: string,
  reason: string,
  cause?: "idle" | "admin",
): Promise<void> {
  const [agg] = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${acpEvents.seq}), 0)` })
    .from(acpEvents)
    .where(eq(acpEvents.sessionId, sessionId));
  const seq = Number(agg?.maxSeq ?? 0) + 1;
  const createdAt = new Date();
  const payload = { status: "ended", reason };
  // This session is not live, so its tenant is read back from the row rather
  // than carried in memory. Same rule as persistEvent: the event's tenant is the
  // session's, which the composite FK then checks.
  const [sessionRow] = await db
    .select({ tenantId: acpSessions.tenantId })
    .from(acpSessions)
    .where(eq(acpSessions.id, sessionId));
  if (!sessionRow) return;
  await db.insert(acpEvents).values({
    sessionId,
    tenantId: sessionRow.tenantId,
    seq,
    type: "state",
    payload,
    createdAt,
  });
  await db
    .update(acpSessions)
    .set({
      status: "ended",
      endedReason: reason,
      ...(cause ? { endedCause: cause } : {}),
      lastEventAt: createdAt,
      // This row is not live, so seq came from MAX(seq)+1 — the same
      // last_seq invariant persistEvent maintains for live sessions.
      lastSeq: seq,
    })
    .where(eq(acpSessions.id, sessionId));
  fanOut(sessionId, {
    sessionId,
    seq,
    type: "state",
    payload,
    createdAt: createdAt.toISOString(),
  });
}

/** Test hook: live subscriber count for a session (leak detection). */
export function _subscriberCountForTest(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}

/** Subscribe to live events; replay is the caller's job (read acp_events). */
export function subscribe(
  sessionId: string,
  fn: (e: AcpEvent) => void,
): () => void {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const current = subscribers.get(sessionId);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) subscribers.delete(sessionId);
  };
}
