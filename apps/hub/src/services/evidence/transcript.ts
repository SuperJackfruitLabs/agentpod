/**
 * A session's transcript, as evidence (superwitness transcripts spec §3.3).
 *
 * Read from `acp_events` — the source of truth — folded with the contract's evidence fold,
 * redacted, and cut to size. Nothing here is stored, cached or logged: the content exists in
 * this process only for the length of one request.
 *
 * The fold always starts at the RANGE's first seq, never at a cursor. A tool call that began on
 * page 1 and finished on page 3 is therefore whole on page 1 and absent from page 3, which is
 * what "a page boundary never splits an item" requires; the cursor only says which already-
 * folded items to skip.
 */
import { and, asc, eq, gt, lte, max, min } from "drizzle-orm";
import { foldEvidenceEvent, emptyEvidenceFold, itemFirstSeq, type EvidenceItem } from "@agentpod/contract";

import { db } from "../../db/drizzle";
import { acpEvents, acpSessions } from "../../db/schema/acp";
import { tenantScope } from "../../db/tenant-scope";
import type { Redactor } from "../redact-content";

export const PAGE_LIMIT = 200;
export const FIELD_LIMIT_BYTES = 16 * 1024;
export const ITEM_LIMIT_BYTES = 1024 * 1024;
/** Rows per read while folding. Bounds memory per request, not the range. */
const FOLD_BATCH = 2000;

export interface TruncatedField {
  truncated: true;
  bytes: number;
  head: string;
}

/** An item as it leaves the hub: redacted, maybe truncated, with its redaction count. */
export type WireItem = Record<string, unknown> & { kind: EvidenceItem["kind"]; redactions: number };

export interface SessionRef {
  id: string;
  stationId: string;
}

export async function findSession(tenant: string, sessionId: string): Promise<SessionRef | null> {
  const [row] = await db
    .select({ id: acpSessions.id, stationId: acpSessions.stationId })
    .from(acpSessions)
    .where(tenantScope(acpSessions, tenant, eq(acpSessions.id, sessionId)))
    .limit(1);
  return row ?? null;
}

/** First and last persisted seq; null for a session with no events yet. */
export async function sessionBounds(tenant: string, sessionId: string): Promise<{ first: number; last: number } | null> {
  const [row] = await db
    .select({ first: min(acpEvents.seq), last: max(acpEvents.seq) })
    .from(acpEvents)
    .where(tenantScope(acpEvents, tenant, eq(acpEvents.sessionId, sessionId)));
  if (!row || row.first === null || row.last === null) return null;
  return { first: Number(row.first), last: Number(row.last) };
}

const INT = /^\d{1,9}$/;

/**
 * `seq_from`/`seq_to` → a range inside the session, or null (400 `bad_range`). Both default to
 * the session's bounds. A session with no events answers only the empty range {0, 0}.
 */
export function parseRange(
  q: { seq_from?: string; seq_to?: string },
  bounds: { first: number; last: number } | null,
): { from: number; to: number } | null {
  for (const v of [q.seq_from, q.seq_to]) if (v !== undefined && !INT.test(v)) return null;
  if (!bounds) return q.seq_from === undefined && q.seq_to === undefined ? { from: 0, to: 0 } : null;
  const from = q.seq_from === undefined ? bounds.first : Number(q.seq_from);
  const to = q.seq_to === undefined ? bounds.last : Number(q.seq_to);
  if (from > to || from < bounds.first || to > bounds.last) return null;
  return { from, to };
}

/** Absent or unreadable → 200; otherwise clamped into 1..200. Never an error. */
export function parseLimit(v: string | undefined): number {
  if (v === undefined || !INT.test(v)) return PAGE_LIMIT;
  return Math.min(PAGE_LIMIT, Math.max(1, Number(v)));
}

export function encodeCursor(seq: number): string {
  return Buffer.from(`s:${seq}`).toString("base64url");
}

export function decodeCursor(cursor: string): number | null {
  const m = /^s:(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m ? Number(m[1]) : null;
}

/** Fold `from..to` in seq order, reading in batches. */
export async function foldRange(tenant: string, sessionId: string, from: number, to: number): Promise<EvidenceItem[]> {
  const f = emptyEvidenceFold();
  let after = from - 1;
  for (;;) {
    const rows = await db
      .select({ seq: acpEvents.seq, type: acpEvents.type, payload: acpEvents.payload })
      .from(acpEvents)
      .where(tenantScope(acpEvents, tenant, eq(acpEvents.sessionId, sessionId), gt(acpEvents.seq, after), lte(acpEvents.seq, to)))
      .orderBy(asc(acpEvents.seq))
      .limit(FOLD_BATCH);
    for (const row of rows) foldEvidenceEvent(f, row);
    if (rows.length < FOLD_BATCH) return f.items;
    after = rows[rows.length - 1]!.seq;
  }
}

/** The items starting at or after `start`, at most `limit`, and the seq the next page starts at. */
export function selectPage(items: EvidenceItem[], start: number, limit: number): { page: EvidenceItem[]; nextSeq: number | null } {
  const rest = items.filter((it) => itemFirstSeq(it) >= start);
  const page = rest.slice(0, limit);
  const next = rest[limit];
  return { page, nextSeq: next ? itemFirstSeq(next) : null };
}

export function redactItem(item: EvidenceItem, redactor: Redactor): WireItem {
  const { value, count } = redactor.value(item);
  return { ...(value as Record<string, unknown>), kind: item.kind, redactions: count };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** A value over the field limit → its marker; otherwise null. Never splits a UTF-8 character. */
export function cutField(v: unknown): TruncatedField | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const buf = encoder.encode(s);
  if (buf.length <= FIELD_LIMIT_BYTES) return null;
  let end = FIELD_LIMIT_BYTES;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { truncated: true, bytes: buf.length, head: decoder.decode(buf.subarray(0, end)) };
}

/** The fields a page cuts: free text, and the tool call's JSON, each measured on its own. */
const TOP_FIELDS = ["text", "title", "message", "reason", "input"] as const;
const OUTPUT_FIELDS = ["content", "raw"] as const;

/** Cut every field over 16 KiB. Runs AFTER redaction, so a head never carries a secret. */
export function truncateItem(item: WireItem): { item: WireItem; truncated: number } {
  let truncated = 0;
  const out: WireItem = { ...item };
  for (const k of TOP_FIELDS) {
    const cut = cutField(out[k]);
    if (cut) {
      out[k] = cut;
      truncated += 1;
    }
  }
  const output = out.output as Record<string, unknown> | undefined;
  if (output && typeof output === "object") {
    const next = { ...output };
    for (const k of OUTPUT_FIELDS) {
      const cut = cutField(next[k]);
      if (cut) {
        next[k] = cut;
        truncated += 1;
      }
    }
    out.output = next;
  }
  return { item: out, truncated };
}
