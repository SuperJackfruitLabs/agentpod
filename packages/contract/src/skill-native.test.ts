import { describe, expect, it } from "bun:test";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";

const base = { key: "codex:fixture", profile: "fixture", operationId: "a".repeat(32) };

describe("native skill activation protocol", () => {
  it("accepts only a bound native plan request", () => {
    expect(VERB_PARAMS["skills.native.plan"].parse({ ...base, action: "activate" })).toEqual({ ...base, action: "activate" });
    expect(VERB_PARAMS["skills.native.plan"].safeParse({ ...base, action: "activate", workspacePath: "/tmp" }).success).toBe(false);
    expect(VERB_PARAMS["skills.native.apply"].safeParse({ ...base, expectedPlanDigest: "b".repeat(64) }).success).toBe(true);
  });

  it("rejects a placement result with an unverified activation claim", () => {
    const fixture = {
      schemaVersion: 1, operationId: "a".repeat(32), action: "activate",
      binding: { nodeId: "node", stationKey: "codex:fixture", harness: "codex", profile: "fixture", workspacePath: "/workspace", workspaceIdentity: "b".repeat(64) },
      repositoryPath: "/workspace", repositoryIdentity: "c".repeat(64), expectedInstallationHead: "d".repeat(64), expectedHead: "e".repeat(64),
      before: null, after: { generation: "a".repeat(32), archiveSHA256: "f".repeat(64), bundleDigest: "0".repeat(64) }, targetPath: "/workspace/.agents/skills/sjl-fixture",
      changes: { added: ["skills/sjl-fixture/SKILL.md"], removed: [], changed: [] }, discoveryNames: ["sjl-fixture:sjl-fixture"],
      activation: "quiescent-project; loading-unverified", createdAt: "2026-09-21T00:00:00Z", planDigest: "1".repeat(64),
    };
    expect(VERB_RESULTS["skills.native.plan"].parse(fixture)).toEqual(fixture);
    expect(VERB_RESULTS["skills.native.plan"].safeParse({ ...fixture, activation: "loaded" }).success).toBe(false);
  });

  it("requires the native verification receipt to name the exact discovered commands", () => {
    const verification = {
      current: null, path: "/workspace/.agents/skills/sjl-fixture", discoveryNames: [],
      present: { value: false, observedAt: "2026-09-21T00:00:00Z", reason: "verified" },
      loaded: { value: null, observedAt: null, reason: "nothing is published" },
    };
    const result = { nodeId: "node", stationKey: "codex:fixture", harness: "codex", profile: "fixture", verification };
    expect(VERB_RESULTS["skills.native.verify"].parse(result)).toEqual(result);
    expect(VERB_RESULTS["skills.native.verify"].safeParse({ ...result, verification: { ...verification, discoveryNames: [""] } }).success).toBe(false);
  });
});
