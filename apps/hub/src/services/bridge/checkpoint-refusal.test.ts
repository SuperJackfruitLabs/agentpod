import { expect, test } from "bun:test";
import { parseBenchCoordinatorResponse, type BenchCoordinatorRequest } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import { CAPACITY_REASON, checkpointRefusal } from "./checkpoint-refusal";

const ids = { externalRunId: "run_ABC123", attemptId: "attempt-fixture" };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fixture = (name: string) => {
  const found = corpus.responses.find((c) => c.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
};

test("a parsed capacity refusal is surfaced by name on the same attempt", async () => {
  const c = fixture("capacity-refused");
  const response = await parseBenchCoordinatorResponse(encode(c.value), c.request as BenchCoordinatorRequest);
  expect(checkpointRefusal(response, ids)).toEqual({ status: "unreported", ...ids, reason: CAPACITY_REASON });
});

test("an unknown refusal code is refused by the contract, never surfaced", async () => {
  const c = fixture("unknown-refusal-code");
  await expect(parseBenchCoordinatorResponse(encode(c.value), c.request as BenchCoordinatorRequest)).rejects.toThrow("Coordinator response refused");
});

test.each(["unavailable", "stale_owner", "verification_failed", "pending"] as const)("refusal %s stays generic", (code) => {
  expect(checkpointRefusal({ version: "agentpod.bench-coordinator.v1", operation: "execute", state: "refused", code }, ids)).toBeUndefined();
});

test("pending is never a refusal", async () => {
  const c = fixture("pending");
  const response = await parseBenchCoordinatorResponse(encode(c.value), c.request as BenchCoordinatorRequest);
  expect(checkpointRefusal(response, ids)).toBeUndefined();
});
