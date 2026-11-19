import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_CALL_TIMEOUT_MS, NODE_CURRENT_DEADLINE_MS } from "./checkpoint-node-call";
import { BOARD_HEARTBEAT_TIMEOUT_MS, RECOVER_MAX_MS } from "./checkpoint-recover-backoff";

test("the Hub's node-call bounds assume the node's own current-decision deadline", () => {
  const go = readFileSync(join(import.meta.dir, "../../../../node-agent/internal/benchbridge/current.go"), "utf8");
  const deadline = /currentDeadline\s*=\s*(\d+)\s*\*\s*time\.Second/.exec(go);
  expect(Number(deadline?.[1]) * 1000).toBe(NODE_CURRENT_DEADLINE_MS);
});

test("each node call outlasts the current checks the node makes inside it", () => {
  // status: one check. prepare: one before the intent and one inside it, then the bench work.
  expect(NODE_CALL_TIMEOUT_MS.status).toBeGreaterThan(NODE_CURRENT_DEADLINE_MS);
  expect(NODE_CALL_TIMEOUT_MS.prepare).toBeGreaterThan(2 * NODE_CURRENT_DEADLINE_MS);
  // The staging rehearsal's prepare and execute both outran the old flat 15 s.
  expect(NODE_CALL_TIMEOUT_MS.prepare).toBeGreaterThan(15_000);
  expect(NODE_CALL_TIMEOUT_MS.execute).toBeGreaterThan(15_000);
});

test("a waiting attempt is re-driven, and its run heartbeated, well inside the board's heartbeat window", () => {
  // The longest gap between two heartbeats: the slowest pass (a status then a re-sent prepare), then the ceiling.
  const slowestPass = NODE_CALL_TIMEOUT_MS.status + NODE_CALL_TIMEOUT_MS.prepare;
  expect(RECOVER_MAX_MS + slowestPass).toBeLessThan(BOARD_HEARTBEAT_TIMEOUT_MS);
});
