/**
 * A routine roster edit (concurrency, the permission wait) rebuilt the loop and stranded every
 * in-flight checkpoint attempt on the station as `authority.changed`: the retained authority pinned
 * the roster row's `updatedAt`. The revision is now a digest of the fields that bear on authority,
 * and attempts reserved under the old revision still match when only that instant moved.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalCheckpoint } from "./checkpoint-json";
import { checkpointAuthorityMatches, rosterAuthorityRevision, selectedCheckpointAuthority, type CheckpointAuthority,
  type RosterAuthorityFields } from "./checkpoint-current";

const source = { version: 1, kind: "station-plane", principalId: "prn_occupant", organizationId: "org_1", audience: "https://app.superpipeline.dev" };
const row: RosterAuthorityFields = { boardId: "brd_ABC123", stationId: "station_1", enabled: true, mode: "full-auto", profileKey: null,
  credentialSource: source };
const owner = { kind: "human" as const, grant: { mayDispatch: ["prn_occupant"], mayGrantReach: false, scopes: [] } };
const facts = (rosterRevision: string): Omit<CheckpointAuthority, "authorizationSnapshotId"> => ({ organizationId: "org_1",
  tenantId: "fleet_1", sourceTenantId: "tenant_1", stationId: "station_1", nodeId: "node_1", occupancyEpoch: 1,
  principalId: "prn_occupant", ownerPrincipalId: "prn_owner", agentKey: "checkpoint", profileKey: "", rosterRevision });

/** The authority exactly as the Hub computed and retained it before this change (updatedAt revision). */
function legacyRetained(updatedAt: string, change: Partial<CheckpointAuthority> = {}, grant = owner.grant): string {
  const after = { ...facts(updatedAt), ...change };
  const snapshot = { ...after, ownerKind: owner.kind, ownerGrant: { mayDispatch: [...grant.mayDispatch].toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0),
    mayGrantReach: grant.mayGrantReach, scopes: [...grant.scopes].toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0) } };
  return canonicalCheckpoint({ ...after, authorizationSnapshotId: "selected-auth:" + createHash("sha256").update(canonicalCheckpoint(snapshot)).digest("hex") });
}

test("the roster revision digests only the fields that bear on authority", () => {
  const revision = rosterAuthorityRevision(row);
  expect(revision).toMatch(/^roster:[a-f0-9]{64}$/);
  // Loop tuning and other paths' credentials are not inputs: a row carrying them digests the same.
  const wholeRow = { ...row, maxConcurrency: 4, permissionWaitMs: 1, tokenEncrypted: "x", updatedAt: new Date() };
  expect(rosterAuthorityRevision(wholeRow)).toBe(revision);
  // The roster stores the default profile as NULL or "": the same default.
  expect(rosterAuthorityRevision({ ...row, profileKey: "" })).toBe(revision);
  for (const change of [{ boardId: "brd_OTHER1" }, { stationId: "station_2" }, { enabled: false }, { mode: "ask" }, { profileKey: "named" },
    { credentialSource: { ...source, audience: "https://other.test" } }, { credentialSource: null }])
    expect(rosterAuthorityRevision({ ...row, ...change })).not.toBe(revision);
});

test("a fresh read matches its own retained authority exactly", () => {
  const fresh = selectedCheckpointAuthority(facts(rosterAuthorityRevision(row)), owner);
  expect(checkpointAuthorityMatches(fresh, canonicalCheckpoint(fresh))).toBe(true);
  const other = selectedCheckpointAuthority(facts(rosterAuthorityRevision({ ...row, mode: "ask" })), owner);
  expect(checkpointAuthorityMatches(other, canonicalCheckpoint(fresh))).toBe(false);
});

test("an attempt retained under an updatedAt revision still matches when only that instant moved", () => {
  const fresh = selectedCheckpointAuthority(facts(rosterAuthorityRevision(row)), owner);
  expect(checkpointAuthorityMatches(fresh, legacyRetained("2026-11-19T21:04:11.000Z"))).toBe(true);
});

test("a legacy attempt still refuses every other authority change", () => {
  const fresh = selectedCheckpointAuthority(facts(rosterAuthorityRevision(row)), owner);
  for (const change of [{ occupancyEpoch: 2 }, { principalId: "prn_other" }, { stationId: "station_2" }, { nodeId: "node_2" },
    { agentKey: "other" }, { profileKey: "named" }, { organizationId: "org_2" }])
    expect(checkpointAuthorityMatches(fresh, legacyRetained("2026-11-19T21:04:11.000Z", change))).toBe(false);
  expect(checkpointAuthorityMatches(fresh, legacyRetained("2026-11-19T21:04:11.000Z", {}, { ...owner.grant, mayDispatch: [] }))).toBe(false);
  // A retained digest revision is never re-read as legacy, and nothing unreadable matches.
  const digestRetained = canonicalCheckpoint(selectedCheckpointAuthority(facts("roster:" + "0".repeat(64)), owner));
  expect(checkpointAuthorityMatches(fresh, digestRetained)).toBe(false);
  expect(checkpointAuthorityMatches(fresh, "not json")).toBe(false);
  expect(checkpointAuthorityMatches(fresh, null)).toBe(false);
  // Only an authority this module selected carries a legacy view: a copy matches exactly or not at all.
  expect(checkpointAuthorityMatches({ ...fresh }, legacyRetained("2026-11-19T21:04:11.000Z"))).toBe(false);
});
