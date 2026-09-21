import { expect, test } from "bun:test";
import { unconfirmedNodeOperationReason } from "./skill-operation-diagnostics";

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
