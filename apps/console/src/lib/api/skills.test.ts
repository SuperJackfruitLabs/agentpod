import { test, expect, vi, afterEach } from "vitest";
import * as client from "./client";
import * as skills from "./skills";
import { planFixture } from "../../../../../packages/contract/src/fixtures/skill-install";

afterEach(() => vi.restoreAllMocks());
const operation = {
  id: planFixture.operationId,
  stationId: "station_1",
  nodeId: "fixture-node",
  stationKey: "codex:fixture",
  harness: "codex",
  profile: "fixture",
  kind: "managed",
  action: "install",
  artifactId: "11111111-1111-4111-8111-111111111111",
  state: "planned",
  error: null,
  inFlight: false,
  createdAt: planFixture.createdAt,
  updatedAt: planFixture.createdAt,
  plan: planFixture,
  receipt: null,
};
test("refuses a foreign station, changed operation ID or inconsistent plan binding", async () => {
  const http = vi.spyOn(client, "http");
  for (const data of [
    { ...operation, stationId: "other" },
    { ...operation, id: "b".repeat(32) },
    {
      ...operation,
      plan: {
        ...planFixture,
        binding: { ...planFixture.binding, profile: "other" },
      },
    },
  ]) {
    http.mockResolvedValueOnce(data);
    await expect(
      skills.getSkillOperation("station_1", operation.id),
    ).rejects.toThrow();
  }
});
test("sends only the reviewed digest to the selected operation", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue(operation);
  await skills.applySkillOperation(
    "station_1",
    operation.id,
    planFixture.planDigest,
  );
  expect(http).toHaveBeenCalledWith(
    `/api/stations/station_1/skills/operations/${operation.id}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planDigest: planFixture.planDigest }),
    },
  );
});
test("refuses a verification for another profile", async () => {
  vi.spyOn(client, "http").mockResolvedValue({
    nodeId: "fixture-node",
    stationKey: "codex:fixture",
    harness: "codex",
    profile: "other",
    verification: {
      current: null,
      path: null,
      present: {
        value: false,
        reason: "No revision",
        observedAt: planFixture.createdAt,
      },
      loaded: { value: null, reason: "Not observed", observedAt: null },
    },
  });
  await expect(
    skills.verifySkillFiles("station_1", "fixture"),
  ).rejects.toThrow();
});
test("rejects oversized artifacts before sending bytes", async () => {
  const http = vi.spyOn(client, "http");
  await expect(
    skills.uploadSkillArtifact(
      { size: 32 * 1024 * 1024 + 1 } as File,
      "codex",
      "fixture",
    ),
  ).rejects.toThrow(/32 MiB/);
  expect(http).not.toHaveBeenCalled();
});
test("records only the exact release record and its harness pins", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222", version: "1.2.3", profile: "fixture", recordDigest: "a".repeat(64), createdAt: planFixture.createdAt });
  const record = { schema_version: 1, version: "1.2.3", profile: "fixture", visibility: "private", artifacts: ["codex", "claude-code", "opencode", "pi", "hermes", "openclaw"].map(harness => ({ harness, bundle_digest: "b".repeat(64), archive_sha256: "c".repeat(64), path: `archives/${harness}/sjl-fixture.tar.gz` })), digest: "d".repeat(64) } as never;
  await skills.importTrustedSkillRelease(record, [{ harness: "codex", artifactId: "11111111-1111-4111-8111-111111111111" }] as never);
  expect(http).toHaveBeenCalledWith("/api/skills/catalog/releases", expect.objectContaining({ method: "POST", body: JSON.stringify({ record, artifacts: [{ harness: "codex", artifactId: "11111111-1111-4111-8111-111111111111" }] }) }));
});
