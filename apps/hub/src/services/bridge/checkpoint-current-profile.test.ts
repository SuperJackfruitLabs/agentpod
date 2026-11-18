import { afterEach, expect, spyOn, test } from "bun:test";
import { connectionManager } from "../broker";
import { factsMatchProfile, type RosterFacts } from "./checkpoint-current";
import { normalizeRosterProfileKey, parseCheckpointProfile } from "./checkpoint-profile";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";

const priorEnforce = process.env.ENFORCE_CONTROL_PAIR;
afterEach(() => {
  if (priorEnforce === undefined) delete process.env.ENFORCE_CONTROL_PAIR; else process.env.ENFORCE_CONTROL_PAIR = priorEnforce;
});

function profileFor(profileKey: string) {
  const request = corpus.requests.find((item) => item.name === "prepare")?.value;
  if (!request || !("target" in request) || !request.target) throw new Error("fixture target missing");
  return parseCheckpointProfile({ version: "agentpod.checkpoint-profile.v1", organizationId: "org_" + "a".repeat(20),
    sourceTenantId: "tnt_source", sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
    reporterPrincipalId: "prn_" + "b".repeat(20), ownerPrincipalId: "prn_" + "c".repeat(20),
    occupantPrincipalId: "prn_" + "d".repeat(20), agentKey: "fixture", profileKey, coordinatorProfileId: "coord", occupancyEpoch: 1,
    target: request.target, checkpointRepository: "api",
    repositories: [{ name: "api", provider: "forge", repository: "example/api", repositorySHA256: "e".repeat(64), objectFormat: "sha1" }] });
}
function select(rosterProfileKey: string | null, profileKey: string) {
  process.env.ENFORCE_CONTROL_PAIR = "true";
  const profile = profileFor(profileKey);
  const facts: RosterFacts = { organizationId: profile.organizationId, source: "org-plane", nodeId: profile.target.node_id,
    principalId: profile.occupantPrincipalId, ownerPrincipalId: profile.ownerPrincipalId, occupancyEpoch: profile.occupancyEpoch,
    profileKey: rosterProfileKey, nodeStatus: "online", lastSeenAt: new Date() };
  const online = spyOn(connectionManager, "isOnline").mockReturnValue(true);
  try { return factsMatchProfile(facts, profile, Date.now()); } finally { online.mockRestore(); }
}

test("a station on its default profile (NULL) is selectable for a default checkpoint profile", () => {
  expect(select(null, "")).toBe(true);
});
test("a station on a default profile spelled as an empty string is the same default", () => {
  expect(select("", "")).toBe(true);
});
test("a NULL roster profile never matches a named checkpoint profile", () => {
  expect(select(null, "named")).toBe(false);
});
test("a named roster profile matches only itself", () => {
  expect(select("named", "named")).toBe(true);
  expect(select("named", "other")).toBe(false);
  expect(select("named", "")).toBe(false);
});
test("normalisation maps only NULL and undefined to the default", () => {
  expect(normalizeRosterProfileKey(null)).toBe("");
  expect(normalizeRosterProfileKey(undefined)).toBe("");
  expect(normalizeRosterProfileKey("x")).toBe("x");
});
