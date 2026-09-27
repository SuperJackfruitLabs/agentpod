export const planFixture = {
  schemaVersion: 1, operationId: "a".repeat(32), action: "install",
  binding: { nodeId: "fixture-node", stationKey: "codex:fixture", harness: "codex", profile: "fixture", workspacePath: "/fixture/workspace", workspaceIdentity: "b".repeat(64) },
  expectedHead: "c".repeat(64), before: null,
  after: { generation: "a".repeat(32), archiveSHA256: "d".repeat(64), bundleDigest: "e".repeat(64) },
  targetPath: "/fixture/workspace/.agentpod-skills/fixture/generations/" + "a".repeat(32),
  changes: { added: ["skills/fixture/SKILL.md"], removed: [], changed: [] },
  activation: "pending", createdAt: "2026-09-20T16:00:00Z", planDigest: "f".repeat(64),
};
