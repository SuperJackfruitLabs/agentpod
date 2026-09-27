import { expect, test } from "bun:test";
import {
  SkillArtifactMetadata,
  SkillPlanRequest,
  SkillRollbackRequest,
  SkillApplyRequest,
  SkillNativePlanRequest,
  SkillHubOperation,
} from "./skill-management";

test("operator requests refer to an artifact and reviewed plan without accepting broker authority", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const artifactId = "22222222-2222-4222-8222-222222222222";
  expect(SkillPlanRequest.parse({ requestId, artifactId })).toEqual({
    requestId,
    artifactId,
  });
  for (const extra of [
    { key: "codex:other" },
    { nodeId: "foreign" },
    { workspacePath: "/other" },
    { archiveSHA256: "a".repeat(64) },
  ]) {
    expect(
      SkillPlanRequest.safeParse({ requestId, artifactId, ...extra }).success,
    ).toBe(false);
  }
  expect(
    SkillRollbackRequest.safeParse({ requestId, profile: "../other" }).success,
  ).toBe(false);
  expect(
    SkillApplyRequest.safeParse({ planDigest: "a".repeat(64) }).success,
  ).toBe(true);
  expect(SkillApplyRequest.safeParse({ plan: {} }).success).toBe(false);
});

test("uploaded artifact metadata cannot claim native verification or expose bytes", () => {
  const artifact = {
    id: "22222222-2222-4222-8222-222222222222",
    archiveSHA256: "a".repeat(64),
    harness: "codex",
    profile: "fixture",
    size: 100,
    createdAt: "2026-09-20T16:00:00Z",
    validation: "unverified",
  };
  expect(SkillArtifactMetadata.parse(artifact).validation).toBe("unverified");
  expect(
    SkillArtifactMetadata.safeParse({ ...artifact, validation: "loaded" })
      .success,
  ).toBe(false);
  expect(
    SkillArtifactMetadata.safeParse({ ...artifact, bytes: "private" }).success,
  ).toBe(false);
  expect(
    SkillArtifactMetadata.safeParse({ ...artifact, size: 33554433 }).success,
  ).toBe(false);
  expect(SkillHubOperation.safeParse({ state: "applied" }).success).toBe(false);
});

test("native placement is an explicit profile action, independent of artifact upload", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const request = { requestId, profile: "fixture", action: "activate" };
  expect(SkillNativePlanRequest.parse(request)).toEqual(request);
  expect(SkillNativePlanRequest.safeParse({ ...request, artifactId: crypto.randomUUID() }).success).toBe(false);
  expect(SkillNativePlanRequest.safeParse({ ...request, action: "install" }).success).toBe(false);
});
