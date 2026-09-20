const at = "2026-09-20T10:00:00Z";
const unknown = {
  value: null,
  observedAt: null,
  reason: "Not observed by this adapter",
};
const present = { value: true, observedAt: at, reason: "Read the entrypoint" };
export const skillFixture = {
  id: ".agents/skills/example/SKILL.md",
  name: "example",
  description: "A fixture",
  path: "/workspace/.agents/skills/example/SKILL.md",
  scope: "workspace",
  source: {
    kind: "local",
    locator: null,
    revision: null,
    artifactDigest: null,
  },
  entrypointDigest: "a".repeat(64),
  effectivePath: null,
  shadowing: { status: "unknown", by: null, candidates: [] },
  dependencies: { known: false, items: [] },
  compatibility: [],
  evidence: {
    catalogued: unknown,
    present,
    eligible: unknown,
    loaded: unknown,
    exercised: unknown,
  },
};
export const inventoryFixture = {
  stationKey: "codex:fixture",
  harness: "codex",
  observedAt: at,
  skills: [skillFixture],
  plugins: [],
  coverage: {
    complete: false,
    roots: [
      {
        path: "/workspace/.agents/skills",
        scope: "workspace",
        status: "scanned",
      },
    ],
    limitations: ["Session and user roots are not observed"],
  },
  issues: [],
};
// A second fixture populates fields the filesystem adapter cannot establish.
// This checks Go wire fidelity, not a claim of native runtime compatibility.
const knownFalse = {
  value: false,
  observedAt: at,
  reason: "Fixture negative observation",
};
export const inventoryWireFixture = {
  ...inventoryFixture,
  skills: [
    skillFixture,
    {
      ...skillFixture,
      id: "shadowed",
      path: "/workspace/skills/example/SKILL.md",
      effectivePath: skillFixture.path,
      source: {
        kind: "catalog",
        locator: "fixture-library",
        revision: "fixture-revision",
        artifactDigest: "b".repeat(64),
      },
      shadowing: {
        status: "shadowed",
        by: skillFixture.path,
        candidates: [skillFixture.path],
      },
      dependencies: {
        known: true,
        items: [
          { kind: "binary", name: "fixture-tool", available: knownFalse },
        ],
      },
      compatibility: [
        {
          harness: "codex",
          version: "fixture-version",
          mode: "acp",
          result: knownFalse,
          evidenceRef: "fixture-check",
        },
      ],
      evidence: {
        catalogued: present,
        present,
        eligible: knownFalse,
        loaded: knownFalse,
        exercised: unknown,
      },
    },
  ],
  plugins: [
    {
      id: "fixture-plugin",
      name: "fixture-plugin",
      path: "/workspace/fixture-plugin",
      scope: "workspace",
      source: {
        kind: "plugin",
        locator: "fixture-plugin",
        revision: "fixture-revision",
        artifactDigest: null,
      },
      components: ["skills", "commands", "hooks", "mcp", "extensions"],
      activation: knownFalse,
      evidence: {
        catalogued: unknown,
        present,
        eligible: knownFalse,
        loaded: unknown,
        exercised: unknown,
      },
    },
  ],
  issues: [
    {
      path: "/workspace/skills/unreadable",
      reason: "Fixture unreadable entry",
    },
  ],
};
