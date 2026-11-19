import { expect, test } from "bun:test";
import { provenEffectFree, resolveSupersededAttempt, type NodeStatusSummary, type SupersedeDeps } from "./checkpoint-supersede";

const unknown: NodeStatusSummary = { state: "unknown" };
const retiredByNode: NodeStatusSummary = { state: "refused", code: "stale_owner" };
const pending: NodeStatusSummary = { state: "pending" };
const prepared: NodeStatusSummary = { state: "prepared" };

interface Fixture { row: { phase: string } }
const attemptIn = (phase: string): Fixture => ({ row: { phase } });
function deps(reply: NodeStatusSummary | Error, retired = true) {
  const calls: { status: number; retire: unknown[] } = { status: 0, retire: [] };
  const d: SupersedeDeps<Fixture> = {
    status: async () => { calls.status++; if (reply instanceof Error) throw reply; return reply; },
    retire: async (_attempt, retirement) => { calls.retire.push(retirement); return retired; },
  };
  return { d, calls };
}

test("only a no-producer-effect phase with the node's own proof is effect-free", () => {
  expect(provenEffectFree("prepare_pending", unknown)).toBe("superseded.no_record");
  expect(provenEffectFree("prepare_pending", retiredByNode)).toBe("superseded.node_retired");
  expect(provenEffectFree("prepared", retiredByNode)).toBe("superseded.node_retired");
  // A prepared attempt the node no longer knows may still hold a lease.
  expect(provenEffectFree("prepared", unknown)).toBeUndefined();
  for (const reply of [pending, prepared]) expect(provenEffectFree("prepare_pending", reply)).toBeUndefined();
  for (const phase of ["source_pending", "admitted", "execute_pending", "completed", "submission_pending"])
    expect(provenEffectFree(phase, retiredByNode)).toBeUndefined();
});

test("a superseded prepare_pending attempt the node never journaled is retired with the node's reply as evidence", async () => {
  const { d, calls } = deps(unknown);
  expect(await resolveSupersededAttempt(attemptIn("prepare_pending"), d)).toEqual({ outcome: "retired", reason: "superseded.no_record" });
  expect(calls.retire).toEqual([{ reason: "superseded.no_record", by: "hub", evidence: JSON.stringify(unknown) }]);
});

test("a superseded attempt whose node record is still pending stays parked, named", async () => {
  const { d, calls } = deps(pending);
  expect(await resolveSupersededAttempt(attemptIn("prepare_pending"), d)).toEqual({ outcome: "parked", reason: "superseded.node:pending" });
  expect(calls.retire).toHaveLength(0);
});

test("a superseded attempt past the point of producer effect is parked without asking the node", async () => {
  const { d, calls } = deps(retiredByNode);
  expect(await resolveSupersededAttempt(attemptIn("admitted"), d)).toEqual({ outcome: "parked", reason: "superseded.effect_possible" });
  expect(calls.status).toBe(0);
  expect(calls.retire).toHaveLength(0);
});

test("an unreachable node or a raced row retires nothing", async () => {
  // The node's failure is kept, by class and message, for the park's log line.
  expect(await resolveSupersededAttempt(attemptIn("prepare_pending"), deps(new Error("offline")).d))
    .toEqual({ outcome: "parked", reason: "superseded.node_unreachable", error: { errorClass: "Error", error: "offline" } });
  expect(await resolveSupersededAttempt(attemptIn("prepare_pending"), deps(unknown, false).d))
    .toEqual({ outcome: "parked", reason: "superseded.node_raced" });
});
