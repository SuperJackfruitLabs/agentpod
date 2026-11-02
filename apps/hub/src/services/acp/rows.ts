/**
 * Session rows as the contract shows them: the row mapping, titles, the paged list, one row,
 * and the stored transcript.
 */

import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
import type { AcpSessionMode, AcpSessionRow, AcpSessionStatus } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { acpEvents, acpSessions } from "../../db/schema/acp";
import { principalDirectory } from "../../auth/org-plane/directory";

type DbRow = typeof acpSessions.$inferSelect;

export function toContract(r: DbRow): AcpSessionRow {
  return {
    id: r.id,
    stationId: r.stationId,
    userId: r.userId,
    mode: r.mode as AcpSessionMode,
    status: r.status as AcpSessionStatus,
    endedReason: r.endedReason,
    createdAt: r.createdAt.toISOString(),
    lastEventAt: r.lastEventAt.toISOString(),
    // Slice 4c (history): the console's session list renders the title and
    // sizes the transcript from lastSeq — a row that omitted them would leave
    // every session labelled "Session" no matter what was persisted.
    title: r.title,
    lastSeq: r.lastSeq,
    endedCause: (r.endedCause as "idle" | "admin" | null) ?? null,
    resumedFrom: r.resumedFrom ?? null,
    resumedAs: r.resumedAs ?? null,
    resumable: isResumable(r),
    ...(r.executionAuthority
      ? {
          execution: {
            promptReceipts: 1 as const,
            state: r.executionAuthority.state,
            sessionId: r.executionAuthority.sessionId,
            stopConfirmed:
              r.executionAuthority.state === "revoked" &&
              r.executionAuthority.receipt?.owned_execution_stopped === true &&
              r.executionAuthority.receipt.unresolved_operations.length === 0,
          },
        }
      : {}),
  };
}

/**
 * An ended interactive Salaam session that nobody has resumed yet. Whether the CALLER may resume
 * it is the owner check in `resumeSession`; a row is only ever listed resumable to its owner.
 */
function isResumable(r: DbRow): boolean {
  return (
    r.status === "ended" &&
    r.executionAuthority?.binding.run.source === "agentpod" &&
    !r.resumedAs
  );
}

// ─── Session titles ───────────────────────────────────────────────────────────

/**
 * Stored title length, counted in CODE POINTS. Truncation is stored as-is with
 * NO ellipsis: how a clipped title is presented (…, fade, tooltip) is the
 * console's choice, and baking a glyph in here would corrupt the data for every
 * other reader.
 */
const TITLE_MAX_CHARS = 80;

/**
 * The title a prompt would give a session: trimmed, clipped to 80 code points.
 * Whitespace-only prompts name nothing (null) — the next real prompt titles
 * the session instead.
 *
 * The cut is code-point-safe (Array.from, not slice): `"a".repeat(79) + "😀"`
 * has 81 UTF-16 code units, and a plain `slice(0, 80)` would keep the emoji's
 * HIGH SURROGATE only. That lone surrogate is not valid UTF-8, so postgres.js
 * drops it on the way in — the emoji vanishes and the stored title is 79 chars,
 * silently, with no error anywhere. Code points, not grapheme clusters
 * (Intl.Segmenter): the contract is a character budget, and a grapheme-limited
 * cut could store far more than 80 characters. A multi-code-point emoji
 * sequence (ZWJ family, flag) can still be split at the boundary, but every
 * piece stays well-formed text — which is the invariant that matters here.
 */
export function deriveSessionTitle(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const points = Array.from(trimmed);
  if (points.length <= TITLE_MAX_CHARS) return trimmed;
  return points.slice(0, TITLE_MAX_CHARS).join("");
}

/** A person's display name for a refusal or a list; never throws (a plane outage says "Someone"). */
export async function displayName(userId: string): Promise<string> {
  try {
    const p = await principalDirectory().principal(userId);
    return p?.displayName || p?.handle || "Someone";
  } catch {
    return "Someone";
  }
}

// ─── Session listing ─────────────────────────────────────────────────────────

/** Page size when the caller doesn't say. */
const SESSION_PAGE_DEFAULT_LIMIT = 20;
/** Hard ceiling on one page — a station can accumulate thousands of sessions. */
const SESSION_PAGE_MAX_LIMIT = 100;

export interface ListSessionsOptions {
  /** Every person's sessions on the station (a workspace owner/admin's read). */
  everyone?: boolean;
  /** Name each row's owner (`owner`), for a list that can hold other people's sessions. */
  withOwners?: boolean;
  /** Page size; defaults to 20 and is clamped into [1, 100]. */
  limit?: number;
  /**
   * `lastEventAt` cursor (ISO) from the last row of the previous page: return
   * only rows older than this. Pair it with `beforeId` — on its own it can only
   * express "strictly older", which LOSES rows tied on the timestamp.
   */
  before?: string;
  /**
   * `id` of the same cursor row, completing the keyset. With it the predicate
   * becomes (lastEventAt, id) < (before, beforeId) in the list's own ordering,
   * so rows sharing `before` resume exactly where the page stopped.
   */
  beforeId?: string;
}

/**
 * The page size to use for `limit`: default when absent or not a number,
 * otherwise floored into [1, 100].
 *
 * Out-of-range numbers are clamped rather than refused — a client asking for
 * 1000 rows gets 100, not an error. Deciding that a *non-numeric* limit is a
 * client bug worth a 400 is the route's job (it can't be told apart from a
 * default down here).
 */
export function clampSessionLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return SESSION_PAGE_DEFAULT_LIMIT;
  }
  return Math.min(SESSION_PAGE_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * One page of the caller's sessions for a station, newest ACTIVITY first (id
 * desc breaks same-millisecond ties). Ordered and limited in SQL — backed by
 * acp_sessions_station_activity_idx — so the console's session switcher and the
 * history view share one read; callers must not re-sort.
 *
 * Paging is keyset, not offset: pass the last row of the previous page back as
 * `before` (its lastEventAt) AND `beforeId` (its id), and rows arriving
 * meanwhile can't shift the page under the caller.
 *
 * Both halves matter. lastEventAt comes from `new Date()`, so several rows
 * sharing one millisecond is ordinary — and a timestamp-only cursor with
 * `lastEventAt < before` excludes every tied row from EVERY later page, not
 * just this one. A session tied with the page boundary would disappear from
 * history for good, silently. `beforeId` closes that hole by resuming inside
 * the tie group. It stays optional only for cross-version tolerance: a console
 * that sends `before` alone gets the old strict-older behaviour rather than an
 * error.
 */
export async function listSessions(
  userId: string,
  stationId: string,
  opts: ListSessionsOptions = {},
): Promise<AcpSessionRow[]> {
  const filters = [eq(acpSessions.stationId, stationId)];
  // Everyone's sessions only for a workspace owner/admin, and only when asked for (the history
  // dialog). The caller must already have scoped the station to their workspace.
  if (!opts.everyone) filters.push(eq(acpSessions.userId, userId));
  if (opts.before !== undefined) {
    const cursor = new Date(opts.before);
    if (Number.isNaN(cursor.getTime())) {
      throw new Error("Invalid page cursor.");
    }
    filters.push(
      opts.beforeId === undefined
        ? lt(acpSessions.lastEventAt, cursor)
        : // (lastEventAt, id) < (before, beforeId) — the list's own ordering.
          or(
            lt(acpSessions.lastEventAt, cursor),
            and(
              eq(acpSessions.lastEventAt, cursor),
              lt(acpSessions.id, opts.beforeId),
            ),
          )!,
    );
  }
  const rows = await db
    .select()
    .from(acpSessions)
    .where(and(...filters))
    .orderBy(desc(acpSessions.lastEventAt), desc(acpSessions.id))
    .limit(clampSessionLimit(opts.limit));
  if (!opts.withOwners) return rows.map(toContract);
  const names = new Map<string, string>();
  for (const id of new Set(rows.map((r) => r.userId)))
    if (id !== userId) names.set(id, await displayName(id));
  return rows.map((r) => {
    const you = r.userId === userId;
    const row = toContract(r);
    // Only the owner may resume (see resumeSession), so nobody else is told it is resumable.
    return { ...row, resumable: you && row.resumable, owner: { name: you ? "You" : names.get(r.userId)!, you } };
  });
}

export async function getSession(
  userId: string,
  sessionId: string,
): Promise<AcpSessionRow | null> {
  const rows = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)));
  return rows[0] ? toContract(rows[0]) : null;
}

/**
 * The stored transcript for a session, ordered by seq.
 *
 * Replay has always been the caller's job — the console's session socket does
 * this query inline. Doors needs the same read for `session/load`, where the
 * ACP protocol requires the AGENT to stream history back, so it lives here now
 * rather than being copied a second time.
 */
export async function readEvents(
  sessionId: string,
  sinceSeq = 0,
  scope?: { userId: string; stationId: string },
): Promise<Array<{ seq: number; type: string; payload: unknown }>> {
  // Doors must bind an opaque session ID to the authenticated caller and the
  // station selected by its proxy. A session ID alone is never read authority.
  if (scope) {
    const session = await getSession(scope.userId, sessionId);
    if (!session || session.stationId !== scope.stationId)
      throw Error("Session not found");
  }
  const rows = await db
    .select({
      seq: acpEvents.seq,
      type: acpEvents.type,
      payload: acpEvents.payload,
    })
    .from(acpEvents)
    .where(and(eq(acpEvents.sessionId, sessionId), gt(acpEvents.seq, sinceSeq)))
    .orderBy(asc(acpEvents.seq));
  return rows;
}
