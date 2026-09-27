import { expect, test } from "bun:test";
import { unconfirmedNodeOperationReason, nodeRefusal } from "./skill-operation-diagnostics";

test("keeps broker transport states distinguishable without claiming an outcome", () => {
  expect(unconfirmedNodeOperationReason("plan", "timeout")).toBe(
    "Node timed out during plan; inspect the operation before retrying",
  );
  expect(unconfirmedNodeOperationReason("apply", "node disconnected")).toBe(
    "Node disconnected during apply; inspect the operation before retrying",
  );
});

test("retains a bounded node rejection while redacting local paths", () => {
  const reason = unconfirmedNodeOperationReason(
    "plan",
    "skills: native activation refused at /Users/rakeshgangwar/new-game/.agents/skills",
  );
  expect(reason).toContain("Node rejected plan: skills: native activation refused at [path redacted]");
  expect(reason).not.toContain("rakeshgangwar");
});

// A node that refuses for a stateable reason is not a node that failed.
//
// `skills/maintenance/plan` returned 502 "Node maintenance preview is
// unavailable or invalid" for two DIFFERENT healthy refusals found on a live
// station: an interrupted operation that had not been resumed, and a retained
// backup still referenced by the live head. Both are recoverable, both name
// what to do, and both read to an operator as "the node is broken".
test("a node conflict is a conflict, not a bad gateway", () => {
  for (const nodeError of [
    "skill installation conflict: native operation requires recovery",
    "skill installation conflict: retained native backup is not safely removable",
    "skill installation conflict: maintenance requires recovery",
  ]) {
    const outcome = nodeRefusal(nodeError);
    expect(outcome.status).toBe(409);
    // The operator is told which condition, not just that something is wrong.
    expect(outcome.message).toContain(nodeError.replace("skill installation conflict: ", ""));
  }
});

test("transport failures stay a bad gateway, because the node did not answer", () => {
  for (const nodeError of ["timeout", "node offline", "node disconnected", undefined]) {
    expect(nodeRefusal(nodeError).status).toBe(502);
  }
});

test("a node conflict is bounded and redacts local paths like every other node text", () => {
  const outcome = nodeRefusal(
    "skill installation conflict: retained generation at /Users/rakeshgangwar/sjl-pi-canary/.agentpod-skills/abc is not removable",
  );
  expect(outcome.status).toBe(409);
  expect(outcome.message).not.toContain("rakeshgangwar");
  expect(outcome.message).toContain("[path redacted]");
  expect(outcome.message.length).toBeLessThanOrEqual(600);
});
