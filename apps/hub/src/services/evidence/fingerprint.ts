/**
 * The configuration fingerprint (superwitness contract C3; charter
 * decisions/2026-09-29-evidence-joins-on-the-work-run.md, decision 3).
 *
 * An evaluation groups by the digest, and three runtimes compute it, so its bytes are pinned by
 * `fixtures/evidence/fingerprint_digest.json` rather than by this file's opinion. JSON.stringify
 * IS the canonical form: it leaves `<`, `>`, `&` and non-ASCII literal, which is what the vectors
 * require and what Go's default encoder does not do.
 */
import { createHash } from "node:crypto";

import type { StoredFingerprint } from "../../db/schema/acp";

export const FINGERPRINT_FIELDS = ["harness", "harness_version", "model", "profile", "skill_release"] as const;
export type FingerprintField = (typeof FINGERPRINT_FIELDS)[number];
export type FingerprintFields = Record<FingerprintField, string>;
export type ReportedBy = "harness" | "station" | "hub";

/** Unknown is a value. It is never a blank, a null or a guess. */
export const UNKNOWN = "unknown";

export interface Fingerprint extends FingerprintFields {
  reported_by: ReportedBy;
  digest: string;
}

export function normaliseFields(
  input: Partial<Record<FingerprintField, string | null | undefined>>,
): FingerprintFields {
  const out = {} as FingerprintFields;
  for (const k of FINGERPRINT_FIELDS) {
    const v = input[k];
    const trimmed = typeof v === "string" ? v.trim() : "";
    out[k] = trimmed === "" ? UNKNOWN : trimmed;
  }
  return out;
}

export function canonicalFingerprintJson(fields: FingerprintFields): string {
  const sorted: Record<string, string> = {};
  for (const k of [...FINGERPRINT_FIELDS].sort()) sorted[k] = fields[k];
  return JSON.stringify(sorted);
}

export function fingerprintDigest(fields: FingerprintFields): string {
  return "sha256:" + createHash("sha256").update(canonicalFingerprintJson(fields), "utf8").digest("hex");
}

export function makeFingerprint(
  input: Partial<Record<FingerprintField, string | null | undefined>>,
  reportedBy: ReportedBy,
): Fingerprint {
  const fields = normaliseFields(input);
  return { ...fields, reported_by: reportedBy, digest: fingerprintDigest(fields) };
}

export function toStored(f: Fingerprint): StoredFingerprint {
  return {
    harness: f.harness,
    harness_version: f.harness_version,
    model: f.model,
    profile: f.profile,
    skill_release: f.skill_release,
    reported_by: f.reported_by,
  };
}
