/**
 * The hub's evidence routes (superwitness contract C5), as superwitness reads them.
 * Pinned by `fixtures/evidence/hub_evidence_*.json`. Strict on purpose: a field added here
 * without a fixture bump is a field no consumer was told about.
 */
import { z } from "zod";

import { AcpRunId, AcpSessionId, PrincipalId } from "./ids";

const Known = z.string().min(1);
const Iso = z.iso.datetime();

export const EvidenceFingerprint = z
  .object({
    /** `sha256:<64 hex>`, or `unknown` for an attempt written before fingerprints existed. */
    digest: z.union([z.literal("unknown"), z.string().regex(/^sha256:[0-9a-f]{64}$/)]),
    harness: Known,
    harness_version: Known,
    model: Known,
    profile: Known,
    skill_release: Known,
    reported_by: z.enum(["harness", "station", "hub"]),
  })
  .strict();
export type EvidenceFingerprint = z.infer<typeof EvidenceFingerprint>;

/** What an attempt recorded before migration 0085 reads as. */
export const UNKNOWN_FINGERPRINT_VIEW: EvidenceFingerprint = {
  digest: "unknown",
  harness: "unknown",
  harness_version: "unknown",
  model: "unknown",
  profile: "unknown",
  skill_release: "unknown",
  reported_by: "hub",
};

export const EvidenceAttempt = z
  .object({
    id: AcpRunId,
    station_id: Known,
    session_id: AcpSessionId,
    state: Known,
    start_seq: z.number().int().nonnegative(),
    end_seq: z.number().int().nonnegative().nullable(),
    started_at: Iso,
    ended_at: Iso.nullable(),
    /** The station's occupant when the attempt opened (C5). null: unoccupied, or recorded before 0088. */
    agent_principal_id: PrincipalId.nullable(),
    fingerprint: EvidenceFingerprint,
  })
  .strict();
export type EvidenceAttempt = z.infer<typeof EvidenceAttempt>;

export const EvidenceDispatch = z
  .object({
    outcome: z.enum(["working", "produced", "reported", "released", "abandoned"]),
    detail: z.string().nullable(),
    station_id: Known,
    updated_at: Iso,
  })
  .strict();
export type EvidenceDispatch = z.infer<typeof EvidenceDispatch>;

export const EvidenceRunResponse = z
  .object({
    external_source: Known,
    external_run_id: Known,
    board_id: z.string().nullable(),
    card_id: z.string().nullable(),
    dispatch: EvidenceDispatch.nullable(),
    attempts: z.array(EvidenceAttempt),
    as_of: Iso,
  })
  .strict();
export type EvidenceRunResponse = z.infer<typeof EvidenceRunResponse>;

export const EvidenceAttemptResponse = z
  .object({
    external_source: z.string().nullable(),
    external_run_id: z.string().nullable(),
    board_id: z.string().nullable(),
  })
  .strict();
export type EvidenceAttemptResponse = z.infer<typeof EvidenceAttemptResponse>;

/** `GET /api/evidence/principals/:principalId` (C5): just enough to derive a judge's kind. */
export const EvidencePrincipalResponse = z
  .object({
    id: PrincipalId,
    kind: z.enum(["human", "agent", "service"]),
    handle: Known,
    suspended: z.boolean(),
  })
  .strict();
export type EvidencePrincipalResponse = z.infer<typeof EvidencePrincipalResponse>;

// ─── Transcripts (superwitness transcripts spec §3.3) ───────────────────────────────────────────
// Pinned by `fixtures/evidence/hub_evidence_transcript.json` and `…_transcript_item.json`.

/** A field the page route cut at 16 KiB, after redaction. `bytes` is the whole field's size. */
export const EvidenceTruncatedField = z
  .object({ truncated: z.literal(true), bytes: z.number().int().positive(), head: z.string() })
  .strict();
export type EvidenceTruncatedField = z.infer<typeof EvidenceTruncatedField>;

const Text = z.union([z.string(), EvidenceTruncatedField]);
const Seq = z.number().int().positive();
const Count = z.number().int().nonnegative();

export const EvidenceTranscriptItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt"), seq: Seq, text: Text,
    images: z.array(z.object({ name: z.string(), mimeType: z.string() }).strict()),
    redactions: Count,
  }).strict(),
  z.object({ kind: z.literal("message"), seq_from: Seq, seq_to: Seq, text: Text, redactions: Count }).strict(),
  z.object({ kind: z.literal("reasoning"), seq_from: Seq, seq_to: Seq, text: Text, redactions: Count }).strict(),
  z.object({
    kind: z.literal("tool_call"), id: z.string(), seq_from: Seq, seq_to: Seq, title: Text,
    tool_kind: z.string().nullable(), status: z.enum(["pending", "in_progress", "completed", "failed"]),
    /** Any JSON: the harness's own `rawInput`, null when none was sent, or a truncation marker. */
    input: z.unknown(),
    output: z.object({ content: z.unknown(), raw: z.unknown() }).strict(),
    partial: z.literal(true).optional(),
    redactions: Count,
  }).strict(),
  z.object({
    kind: z.literal("permission"), seq: Seq, answer_seq: Seq.optional(), tool_call_id: z.string().optional(),
    title: Text,
    options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.string() }).strict()),
    outcome: z.union([z.enum(["cancelled", "auto", "pending"]), z.string().regex(/^selected:.+$/)]),
    partial: z.literal(true).optional(),
    redactions: Count,
  }).strict(),
  z.object({ kind: z.literal("state"), seq: Seq, status: z.string(), reason: Text.optional(), redactions: Count }).strict(),
  z.object({ kind: z.literal("error"), seq: Seq, error_kind: z.string(), message: Text, redactions: Count }).strict(),
  z.object({ kind: z.literal("other"), seq: Seq, type: z.string(), redactions: Count }).strict(),
]);
export type EvidenceTranscriptItem = z.infer<typeof EvidenceTranscriptItem>;

/** `GET /api/evidence/sessions/:sessionId/transcript`. `seq_from`/`seq_to` are the RANGE, not the page. */
export const EvidenceTranscriptResponse = z
  .object({
    session_id: AcpSessionId,
    /** 0 and 0 only for a session with no events. */
    seq_from: z.number().int().nonnegative(),
    seq_to: z.number().int().nonnegative(),
    items: z.array(EvidenceTranscriptItem).max(200),
    /** Opaque. Send it back with the same seq_from/seq_to for the next page; null on the last. */
    next_cursor: z.string().min(1).nullable(),
    redactions: Count,
    truncated_fields: Count,
  })
  .strict();
export type EvidenceTranscriptResponse = z.infer<typeof EvidenceTranscriptResponse>;

/** `GET /api/evidence/sessions/:sessionId/transcript/items/:seqFrom[?full=1]`. The item carries its own `redactions`. */
export const EvidenceTranscriptItemResponse = z
  .object({ session_id: AcpSessionId, item: EvidenceTranscriptItem })
  .strict();
export type EvidenceTranscriptItemResponse = z.infer<typeof EvidenceTranscriptItemResponse>;

/** Every refusal the transcript routes answer with, by status. */
export const EvidenceTranscriptError = z.union([
  z.object({ error: z.literal("unauthorized") }).strict(), // 401
  z.object({ error: z.literal("forbidden") }).strict(), // 403: no transcripts:read
  z.object({ error: z.literal("not_found") }).strict(), // 404: no such session in your tenant, or no item starts there
  z.object({ error: z.literal("bad_range") }).strict(), // 400
  z.object({ error: z.literal("item_too_large") }).strict(), // 413: over 1 MiB serialised
]);
export type EvidenceTranscriptError = z.infer<typeof EvidenceTranscriptError>;
