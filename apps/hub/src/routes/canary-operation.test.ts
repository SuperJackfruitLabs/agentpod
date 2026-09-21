import { expect, test } from "bun:test";
import { SkillReleaseCanaryOperationRequest } from "@agentpod/contract";
import { canaryOperationIdentity } from "./canary-operation";

test("canary apply keeps its reviewed digest out of the strict operation identity", () => {
  const apply = {
    releaseId: "11111111-1111-4111-8111-111111111111",
    recordDigest: "a".repeat(64),
    stationId: "station_fixture",
    operationId: "b".repeat(32),
    planDigest: "c".repeat(64),
  };
  expect(SkillReleaseCanaryOperationRequest.parse(canaryOperationIdentity(apply))).toEqual({
    releaseId: apply.releaseId,
    recordDigest: apply.recordDigest,
    stationId: apply.stationId,
    operationId: apply.operationId,
  });
});
