import { expect, test } from "bun:test";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { failedDecision, finalRowDecision } from "./checkpoint-current-decision";

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

// The staging sequence: a card moved off the bench stage, so every decision for its attempt refused
// `context` and answered `unavailable`, and the node retried for ever. A decision that fails now asks
// the board; only its definitive answer turns it into `stale_owner`, which lets the node retire.
test("a failed decision whose run the board ended answers stale_owner, so the node retires its record", async () => {
  const attempt = { row: row(), claim: { runId: row().runId } };
  expect(await failedDecision("node", attempt, async () => true)).toBe("stale_owner");
});

test("a failed decision stays unavailable when the board says the run is live, cannot be asked, or the request matched nothing", async () => {
  const attempt = { row: row(), claim: { runId: row().runId } };
  expect(await failedDecision("node", attempt, async () => false)).toBe("unavailable");
  expect(await failedDecision("node", attempt, async () => { throw new Error("board unreachable"); })).toBe("unavailable");
  let asked = false;
  expect(await failedDecision("node", undefined, async () => { asked = true; return true; })).toBe("unavailable");
  expect(asked).toBe(false);
});
