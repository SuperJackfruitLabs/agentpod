import { expect, test } from "bun:test";
import { errorFacts, nodeCallReason, noteCheckpoint, redact, setCheckpointLogForTests } from "./checkpoint-log";
import { httpFailureReason } from "./checkpoint-agent-client";
import { CheckpointRefused } from "./checkpoint-profile";
import { createQuietLog } from "./quiet-log";

test("redaction removes every credential shape this path can carry", () => {
  expect(redact("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [redacted]");
  expect(redact("token spa_a1b2c3 and svc_0123456789abcdef0123:s3cret")).toBe("token spa_[redacted] and svc_[redacted]");
  expect(redact("jwt eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl")).toBe("jwt [jwt]");
  expect(redact("digest " + "a".repeat(64))).toBe("digest [hex]");
  expect(redact("x".repeat(1000))).toHaveLength(300);
});

test("error facts are the class, the redacted message and a closed code: never the stack or the cause", () => {
  const cause = new Error("Bearer secret-token");
  expect(errorFacts(new CheckpointRefused("unavailable", "http.timeout", cause)))
    .toEqual({ errorClass: "CheckpointRefused", error: "Checkpoint refused: unavailable", errorCode: "unavailable", errorReason: "http.timeout" });
  expect(errorFacts("plain")).toEqual({ errorClass: "string", error: "plain" });
  expect(JSON.stringify(errorFacts(cause))).not.toContain("secret-token");
});

test("a note is said once per site, reason and error class, then once per interval", () => {
  let now = 0;
  const lines: Array<Record<string, unknown>> = [];
  const restore = setCheckpointLogForTests(createQuietLog((_m, meta) => lines.push(meta ?? {}), { now: () => now, relogMs: 1000 }));
  try {
    for (let i = 0; i < 5; i++) noteCheckpoint("dispatch", "current.before_context", { runId: "run_1" });
    noteCheckpoint("dispatch", "error", {}, new TypeError("x"));
    noteCheckpoint("dispatch", "error", {}, new RangeError("y"));
    now = 2000;
    noteCheckpoint("dispatch", "current.before_context", { runId: "run_1" });
    expect(lines).toEqual([
      { site: "dispatch", reason: "current.before_context", runId: "run_1" },
      { site: "dispatch", reason: "error", errorClass: "TypeError", error: "x" },
      { site: "dispatch", reason: "error", errorClass: "RangeError", error: "y" },
      { site: "dispatch", reason: "current.before_context", runId: "run_1", suppressed: 4 },
    ]);
  } finally { restore(); }
});

test("a node call's and a bounded request's failures are closed reasons", () => {
  expect(nodeCallReason("timeout")).toBe("node.call.timeout");
  expect(nodeCallReason("node offline")).toBe("node.call.offline");
  expect(nodeCallReason("anything the node said")).toBe("node.call.error");
  expect(httpFailureReason(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe("http.timeout");
  expect(httpFailureReason(new CheckpointRefused("unavailable", "http.size"))).toBe("http.size");
  expect(httpFailureReason(new SyntaxError("bad json"))).toBe("http.body");
  expect(httpFailureReason(new TypeError("fetch failed"))).toBe("http.network");
});
