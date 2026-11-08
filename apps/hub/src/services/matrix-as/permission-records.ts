/**
 * The durable record of a harness permission request projected into a station room
 * (`matrix_permission_requests`): its binding, what it offered, its expiry, and how it closed.
 *
 * charter → "Strict decisions and harness permissions bind their subject" §6. The room's pending
 * request still lives in memory too (`permissions.ts`), because the outbound path asks for it
 * synchronously; this is what an answer is judged against, what survives a restart, and what says
 * a "1" typed after the request closed is late rather than a prompt.
 */

import { and, desc, eq, gt, lte } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { acpEvents } from "../../db/schema/acp";
import { matrixPermissionRequests, matrixRooms, type MatrixPermissionOption } from "../../db/schema/matrix";
import type { HarnessPermission } from "./permission-wire";

export type PermissionStatus = "pending" | "answered" | "expired" | "cancelled";

export interface PermissionRecord {
  requestId: string;
  tenantId: string;
  roomId: string;
  sessionId: string;
  requestSeq: number;
  eventId: string | null;
  digest: string;
  previewComplete: boolean;
  options: MatrixPermissionOption[];
  expiresAt: Date;
  status: PermissionStatus;
  optionId: string | null;
  answeredByPrincipal: string | null;
  closedAt: Date | null;
}

const asStatus = (v: string): PermissionStatus =>
  v === "answered" || v === "expired" || v === "cancelled" ? v : "pending";

function toRecord(row: typeof matrixPermissionRequests.$inferSelect): PermissionRecord {
  return {
    requestId: row.requestId,
    tenantId: row.tenantId,
    roomId: row.roomId,
    sessionId: row.sessionId,
    requestSeq: row.requestSeq,
    eventId: row.eventId,
    digest: row.subjectDigest,
    previewComplete: row.previewComplete,
    options: row.options,
    expiresAt: row.expiresAt,
    status: asStatus(row.status),
    optionId: row.optionId,
    answeredByPrincipal: row.answeredByPrincipal,
    closedAt: row.closedAt,
  };
}

/**
 * Record a request before its message is sent, so an answer racing a slow homeserver finds it.
 * False when the room is not a station room this hub knows (nothing to scope it to). A request seen
 * again (a replayed event) keeps its first record.
 */
export async function recordPermissionRequest(roomId: string, p: HarnessPermission): Promise<boolean> {
  const [room] = await db
    .select({ tenantId: matrixRooms.tenantId })
    .from(matrixRooms)
    .where(eq(matrixRooms.roomId, roomId))
    .limit(1);
  if (!room) return false;
  await db
    .insert(matrixPermissionRequests)
    .values({
      requestId: p.requestId,
      tenantId: room.tenantId,
      roomId,
      sessionId: p.sessionId,
      requestSeq: p.requestSeq,
      subjectDigest: p.subject.digest,
      previewComplete: p.subject.preview_complete,
      options: p.options.map((o) => ({ id: o.id, label: o.label, meaning: o.meaning, ...(o.scope ? { scope: o.scope } : {}) })),
      expiresAt: p.expiresAt,
    })
    .onConflictDoNothing({ target: matrixPermissionRequests.requestId });
  return true;
}

/** The prose message that carries the request: the one event an answer may reference. */
export async function notePermissionEvent(requestId: string, eventId: string): Promise<void> {
  await db.update(matrixPermissionRequests).set({ eventId }).where(eq(matrixPermissionRequests.requestId, requestId));
}

export async function permissionRecord(requestId: string): Promise<PermissionRecord | null> {
  const [row] = await db
    .select()
    .from(matrixPermissionRequests)
    .where(eq(matrixPermissionRequests.requestId, requestId))
    .limit(1);
  return row ? toRecord(row) : null;
}

/** The newest request projected into a room, whatever its state; null when none ever was. */
export async function latestPermissionInRoom(roomId: string): Promise<PermissionRecord | null> {
  const [row] = await db
    .select()
    .from(matrixPermissionRequests)
    .where(eq(matrixPermissionRequests.roomId, roomId))
    .orderBy(desc(matrixPermissionRequests.createdAt))
    .limit(1);
  return row ? toRecord(row) : null;
}

/**
 * Close a request, exactly once: true only for the call that moved it out of `pending`, so two
 * answers — or an answer and the expiry — leave one outcome.
 */
export async function closePermission(
  requestId: string,
  close: { status: Exclude<PermissionStatus, "pending">; optionId?: string; principalId?: string | null; mxid?: string | null },
): Promise<boolean> {
  const rows = await db
    .update(matrixPermissionRequests)
    .set({
      status: close.status,
      optionId: close.optionId ?? null,
      answeredByPrincipal: close.principalId ?? null,
      answeredByMxid: close.mxid ?? null,
      closedAt: new Date(),
    })
    .where(and(eq(matrixPermissionRequests.requestId, requestId), eq(matrixPermissionRequests.status, "pending")))
    .returning({ requestId: matrixPermissionRequests.requestId });
  return rows.length > 0;
}

/** Requests still pending at `now` whose time is up. */
export async function expiredPendingPermissions(now: Date): Promise<PermissionRecord[]> {
  const rows = await db
    .select()
    .from(matrixPermissionRequests)
    .where(and(eq(matrixPermissionRequests.status, "pending"), lte(matrixPermissionRequests.expiresAt, now)));
  return rows.map(toRecord);
}

/** Has anyone prompted this session since the request? Then a bare "1" is no longer a late answer. */
export async function promptedSince(sessionId: string, requestSeq: number): Promise<boolean> {
  const [row] = await db
    .select({ seq: acpEvents.seq })
    .from(acpEvents)
    .where(and(eq(acpEvents.sessionId, sessionId), eq(acpEvents.type, "user-prompt"), gt(acpEvents.seq, requestSeq)))
    .limit(1);
  return row !== undefined;
}
