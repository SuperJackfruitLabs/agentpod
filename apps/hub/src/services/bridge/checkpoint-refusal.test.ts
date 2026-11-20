import { expect, test } from "bun:test";
import { BenchCoordinatorRequest, parseBenchCoordinatorResponse, type BenchCoordinatorResponse } from "@agentpod/contract";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import { CHECKPOINT_REFUSAL_RULINGS, classifyCheckpointRefusal, classifySettlementRefusal, SETTLEMENT_REFUSAL_SENTENCES } from "./checkpoint-refusal";
import { CheckpointRefused } from "./checkpoint-profile";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fixture = (name: string) => {
  const found = corpus.responses.find((c) => c.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
};
const refused = (code: string, operation = "status") => ({ version: "agentpod.bench-coordinator.v1", operation, state: "refused", code });
/** A refusal as the Hub holds it: parsed by the contract from the node's bytes. */
async function parsed(code: string): Promise<BenchCoordinatorResponse> {
  return parseBenchCoordinatorResponse(encode(refused(code)), BenchCoordinatorRequest.parse(fixture("capacity-refused").request));
}

/**
 * The whole ruling, code by code and phase by phase. A change to any cell turns this red: that is
 * the revert-proof for every classification, and the doc's table reads the same object.
 */
const RULING = {
  verification_failed: ["failed", "failed"],
  unsupported: ["failed", "failed"],
  capacity_exhausted: ["released", "released"],
  conflict: ["released", undefined],
  stale_owner: [undefined, undefined],
  unavailable: [undefined, undefined],
  invalid: [undefined, undefined],
  unauthorized: [undefined, undefined],
  pending: [undefined, undefined],
} as const;

test.each(Object.entries(RULING))("refusal %s is ruled per phase", async (code, [prepare, execute]) => {
  const response = await parsed(code);
  expect(classifyCheckpointRefusal("prepare_pending", response)?.disposition).toBe(prepare);
  expect(classifyCheckpointRefusal("execute_pending", response)?.disposition).toBe(execute);
});

test("the ruling covers every refusal code the contract admits, and no other", async () => {
  expect(new Set(Object.keys(CHECKPOINT_REFUSAL_RULINGS))).toEqual(new Set(Object.keys(RULING)));
  // A code the contract does not know never reaches the ruling: the parse refuses it first.
  const c = fixture("unknown-refusal-code");
  await expect(parseBenchCoordinatorResponse(encode(c.value), BenchCoordinatorRequest.parse(c.request))).rejects.toThrow("Coordinator response refused");
});

test("a terminal ruling says what happened in one sentence, naming the code", async () => {
  for (const code of ["verification_failed", "unsupported", "capacity_exhausted", "conflict"] as const) {
    const ruling = classifyCheckpointRefusal("prepare_pending", await parsed(code));
    expect(ruling?.code).toBe(code);
    expect(ruling?.reason).toMatch(/^Checkpoint (failed|released): /);
  }
  const crash = classifyCheckpointRefusal("execute_pending", await parsed("verification_failed"));
  expect(crash?.reason).toContain("verification_failed");
  expect(crash?.reason).toContain("Nothing was reported as a pass");
});

test("only the two phases that ask the node take a ruling", async () => {
  const response = await parsed("verification_failed");
  for (const phase of ["prepared", "source_pending", "admitted", "completed", "submission_pending", "reported", "retired", "failure_pending", "failed"])
    expect(classifyCheckpointRefusal(phase, response)).toBeUndefined();
});

test("a reply that is not a refusal is never ruled", async () => {
  for (const name of ["pending", "unknown", "superseded"]) {
    const c = fixture(name);
    const response = await parseBenchCoordinatorResponse(encode(c.value), BenchCoordinatorRequest.parse(c.request));
    expect(classifyCheckpointRefusal("execute_pending", response)).toBeUndefined();
  }
});

const SETTLEMENT_REFUSALS = ["completion", "retained_source", "foreign_source", "task_outcome", "unchanged", "foreign_member", "shape", "size"] as const;
test("every settlement refusal has a ruling", () => {
  expect(new Set(Object.keys(SETTLEMENT_REFUSAL_SENTENCES))).toEqual(new Set(SETTLEMENT_REFUSALS));
});
test.each(SETTLEMENT_REFUSALS)("settlement refusal %s is deterministic: the run is failed, never passed", (why) => {
  const ruling = classifySettlementRefusal(new CheckpointRefused("source", `settlement.${why}`));
  expect(ruling).toMatchObject({ code: `settlement.${why}`, disposition: "failed" });
  expect(ruling?.reason).toMatch(/^Checkpoint failed: the run finished/);
  expect(ruling?.reason).toEndWith("Nothing was reported as a pass.");
});

test("the unchanged sentence says what happened", () => {
  expect(classifySettlementRefusal(new CheckpointRefused("source", "settlement.unchanged"))?.reason)
    .toBe("Checkpoint failed: the run finished but produced no change, and this stage requires one. Nothing was reported as a pass.");
});

test("anything after completion that is not a settlement refusal is transient: never ruled", () => {
  for (const error of [new CheckpointRefused("stale", "ledger.raced"), new CheckpointRefused("stale", "source.inactive"),
    new CheckpointRefused("unavailable", "service.error"), new CheckpointRefused("source"), new Error("boom"), undefined])
    expect(classifySettlementRefusal(error)).toBeUndefined();
});
