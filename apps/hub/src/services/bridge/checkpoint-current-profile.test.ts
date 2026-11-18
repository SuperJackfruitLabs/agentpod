import { afterEach, expect, spyOn, test } from "bun:test";
import { connectionManager } from "../broker";
import { currentFacts } from "./checkpoint-current";
import { CheckpointRefused, normalizeRosterProfileKey, type CheckpointProfile } from "./checkpoint-profile";

const priorEnforce = process.env.ENFORCE_CONTROL_PAIR;
afterEach(() => {
  if (priorEnforce === undefined) delete process.env.ENFORCE_CONTROL_PAIR; else process.env.ENFORCE_CONTROL_PAIR = priorEnforce;
});

function profileFor(profileKey: string): CheckpointProfile {
  return { organizationId: "org_a", sourceTenantId: "src", occupantPrincipalId: "prn_o", ownerPrincipalId: "prn_w",
    occupancyEpoch: 3, agentKey: "agent", profileKey, coordinatorProfileId: "coord",
    target: { station_id: "stn", tenant_id: "tnt", node_id: "nod", board_id: "brd" } } as unknown as CheckpointProfile;
}
/** A drizzle-shaped builder whose terminal await yields one roster/station fact row. */
function execWith(rosterProfileKey: string | null) {
  const row = { tenantId: "tnt", organizationId: "org_a", source: "org-plane", stationId: "stn", principalId: "prn_o",
    ownerPrincipalId: "prn_w", occupancyEpoch: 3, nodeId: "nod", nodeStatus: "online", lastSeenAt: new Date(),
    profileKey: rosterProfileKey, agentKey: "agent", rosterRevision: new Date(0) };
  const chain: unknown = new Proxy(() => chain, { get: (_t, k) => k === "then" ? (ok: (v: unknown) => void) => ok([row]) : () => chain });
  return chain as never;
}
async function select(rosterProfileKey: string | null, profileKey: string) {
  process.env.ENFORCE_CONTROL_PAIR = "true";
  const online = spyOn(connectionManager, "isOnline").mockReturnValue(true);
  try { return await currentFacts(profileFor(profileKey), execWith(rosterProfileKey)); } finally { online.mockRestore(); }
}

test("a station on its default profile (NULL) is selectable for a default checkpoint profile", async () => {
  expect((await select(null, "")).profileKey).toBe("");
});
test("a station on a default profile spelled as an empty string is the same default", async () => {
  expect((await select("", "")).profileKey).toBe("");
});
test("a NULL roster profile never matches a named checkpoint profile", async () => {
  await expect(select(null, "named")).rejects.toBeInstanceOf(CheckpointRefused);
});
test("a named roster profile matches only itself", async () => {
  expect((await select("named", "named")).profileKey).toBe("named");
  await expect(select("named", "other")).rejects.toBeInstanceOf(CheckpointRefused);
  await expect(select("named", "")).rejects.toBeInstanceOf(CheckpointRefused);
});
test("normalisation maps only NULL and undefined to the default", () => {
  expect(normalizeRosterProfileKey(null)).toBe("");
  expect(normalizeRosterProfileKey(undefined)).toBe("");
  expect(normalizeRosterProfileKey("x")).toBe("x");
});
