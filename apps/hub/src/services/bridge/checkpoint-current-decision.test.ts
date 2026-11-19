import { expect, test } from "bun:test";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { finalRowDecision } from "./checkpoint-current-decision";

function row(): RetainedCheckpointAttempt["row"] {
  return { tenantId: "tenant", boardId: "brd_ABC123", runId: "run_ABC123", leaseEpoch: 7, attemptId: "attempt-fixture",
    profile: "{}", claim: "{}", authority: "authority-1", prepareRequest: "{}", prepareSHA256: "e".repeat(64), phase: "execute_pending",
    prepared: null, source: null, sourceReceipt: null, executeRequest: null, executeSHA256: null, completion: null,
    settlementBody: null, settlementSHA256: null, settlementReceipt: null, retirement: null, failure: null, failureReport: null, createdAt: new Date(0), updatedAt: new Date(0) };
}

test("an unchanged row stays current", () => {
  expect(finalRowDecision(row(), row())).toBe("current");
});

test("the Hub moving the row between its two reads is a retryable race, not a stale owner", () => {
  expect(finalRowDecision(row(), { ...row(), phase: "completed", updatedAt: new Date(1) })).toBe("unavailable");
});

test.each([
  ["a missing row", undefined],
  ["another epoch", { ...row(), leaseEpoch: 8 }],
  ["another run", { ...row(), runId: "run_OTHER1" }],
  ["another owner authority", { ...row(), authority: "authority-2" }],
])("%s is a definite stale owner", (_name, final) => {
  expect(finalRowDecision(row(), final)).toBe("stale_owner");
});
