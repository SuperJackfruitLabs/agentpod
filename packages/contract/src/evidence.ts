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
