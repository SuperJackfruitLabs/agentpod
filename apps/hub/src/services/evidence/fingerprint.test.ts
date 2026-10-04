import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FINGERPRINT_FIELDS,
  UNKNOWN,
  canonicalFingerprintJson,
  fingerprintDigest,
  makeFingerprint,
  normaliseFields,
  toStored,
  type FingerprintFields,
} from "./fingerprint";

const corpus = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../../../fixtures/evidence/fingerprint_digest.json"), "utf8"),
) as {
  accept: Array<{ name: string; fields: FingerprintFields; canonical: string; digest: string }>;
  reject: Array<{ reason: string; bytes: string; digest: string; sameConfigurationAs: number }>;
};

const sha = (s: string) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

describe("the C3 digest, held to the shared vectors", () => {
  for (const v of corpus.accept) {
    test(`accept: ${v.name}`, () => {
      expect(canonicalFingerprintJson(v.fields)).toBe(v.canonical);
      expect(fingerprintDigest(v.fields)).toBe(v.digest);
    });
  }

  for (const r of corpus.reject) {
    test(`reject: ${r.reason} is a different digest for the same configuration`, () => {
      // The vector is honest about its own bytes…
      expect(sha(r.bytes)).toBe(r.digest);
      // …and that encoding is NOT what the canonical form produces.
      const same = corpus.accept[r.sameConfigurationAs]!;
      expect(r.bytes).not.toBe(canonicalFingerprintJson(same.fields));
      expect(r.digest).not.toBe(fingerprintDigest(same.fields));
    });
  }

  test("the field list is exactly C3's, already in sorted order", () => {
    expect([...FINGERPRINT_FIELDS]).toEqual(["harness", "harness_version", "model", "profile", "skill_release"]);
    expect([...FINGERPRINT_FIELDS].sort()).toEqual([...FINGERPRINT_FIELDS]);
  });
});

describe("normalisation: unknown is a value, never a blank", () => {
  test("missing, null, empty and whitespace all become unknown; values are trimmed", () => {
    expect(normaliseFields({ harness: " hermes ", model: "", profile: null, skill_release: "   " })).toEqual({
      harness: "hermes",
      harness_version: UNKNOWN,
      model: UNKNOWN,
      profile: UNKNOWN,
      skill_release: UNKNOWN,
    });
  });

  test("reported_by never moves the digest", () => {
    const a = makeFingerprint({ harness: "hermes" }, "hub");
    const b = makeFingerprint({ harness: "hermes" }, "harness");
    expect(a.digest).toBe(b.digest);
    expect(a.reported_by).toBe("hub");
  });

  test("toStored keeps the readable fields and drops the digest", () => {
    const f = makeFingerprint({ harness: "hermes", profile: "press", skill_release: "none" }, "hub");
    expect(toStored(f)).toEqual({
      harness: "hermes",
      harness_version: "unknown",
      model: "unknown",
      profile: "press",
      skill_release: "none",
      reported_by: "hub",
    });
  });
});
