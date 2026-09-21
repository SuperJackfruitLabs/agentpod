import { expect, test } from "bun:test";
import { SkillReleaseCohortCreateRequest, TrustedSkillReleaseRecord } from "./skill-catalog";

const digest = "a".repeat(64);
const harnesses = ["codex", "claude-code", "opencode", "pi", "hermes", "openclaw"] as const;
const record = {
  schema_version: 1,
  version: "1.2.3",
  profile: "fixture",
  visibility: "private",
  artifacts: harnesses.map((harness) => ({
    harness,
    bundle_digest: digest,
    archive_sha256: digest,
    path: `archives/${harness}/sjl-fixture.tar.gz`,
  })),
  digest,
};

test("trusted release records require the canonical six pinned archives", () => {
  expect(TrustedSkillReleaseRecord.parse(record)).toEqual(record);
  expect(TrustedSkillReleaseRecord.safeParse({ ...record, artifacts: [...record.artifacts].reverse() }).success).toBe(false);
  expect(TrustedSkillReleaseRecord.safeParse({ ...record, artifacts: record.artifacts.slice(0, 5) }).success).toBe(false);
  expect(TrustedSkillReleaseRecord.safeParse({ ...record, artifacts: [{ ...record.artifacts[0], path: "archives/codex/sjl-other.tar.gz" }, ...record.artifacts.slice(1)] }).success).toBe(false);
});

test("cohorts pin an immutable release identity and unique station list", () => {
  const cohort = { releaseId: "11111111-1111-4111-8111-111111111111", recordDigest: digest, stationIds: ["station_a", "station_b"] };
  expect(SkillReleaseCohortCreateRequest.parse(cohort)).toEqual(cohort);
  expect(SkillReleaseCohortCreateRequest.safeParse({ ...cohort, stationIds: ["station_a", "station_a"] }).success).toBe(false);
});
