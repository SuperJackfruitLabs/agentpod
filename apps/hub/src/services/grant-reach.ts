/**
 * Who may change what an agent *is*.
 *
 * `mayDispatch` asks whether you may ask an agent to work. This asks whether you
 * may rewrite it — put bytes in its workspace, run commands as it, destroy its
 * files, or bring a new machine into the fleet. Decision 4 of
 * `charter/decisions/2026-08-13-ecosystem-identity.md` requires both, because
 * dispatch control alone is decorative: anyone who can grant an agent production
 * credentials does not need permission to dispatch it — they build the agent
 * they want.
 *
 * Design: `docs/superpowers/specs/2026-08-15-granting-reach-design.md`.
 */

import { eq } from "drizzle-orm";
import { Capability } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { nodes } from "../db/schema";
import { getGrant, grantAllowsStation, AGENTPOD_NS } from "./grants";
import { isControlPairEnforced, GrantReachDenied } from "./control-pair";
import { createLogger } from "../utils/logger";

const log = createLogger("grant-reach");

/**
 * Which capabilities can hand an agent reach it did not have.
 *
 * A `Record<Capability, boolean>` and not a Set: this is exhaustive **by type**,
 * so adding an eleventh capability to the contract enum stops the build until
 * somebody decides what it is. The same manoeuvre `db/tenant-scope.ts` uses to
 * stop a new table quietly escaping tenancy.
 *
 * `cleanup` is listed true even though half its surface is a read — a capability
 * belongs here if ANY route under it can change the agent, and the caller's
 * `effect` argument settles the rest.
 */
export const REACH_BEARING: Record<Capability, boolean> = {
  "fs.write": true, // one request writes a credential file
  terminal: true, // arbitrary shell as the agent's user
  cleanup: true, // `apply` deletes; `plan` is a read and passes on effect

  changeset: false, // status/diff are reads
  lifecycle: false, // operating an agent, not widening it
  acp: false, // dispatch — mayDispatch already guards it
  inventory: false,
  health: false,
  logs: false,
  "fs.read": false,
};

export function isReachBearing(cap: Capability): boolean {
  return REACH_BEARING[cap] === true;
}

/**
 * Guard a station-scoped act.
 *
 * Two conditions, both required: the principal holds `mayGrantReach`, AND their
 * dispatch scope covers this station. One scope list, shared with dispatch, so
 * the two can never disagree about what a pattern means — `grantAllowsStation`
 * is the same function `acp.createSession` calls.
 */
export async function requireGrantReach(
  userId: string,
  station: { nodeId: string; stationKey: string },
  cap: Capability,
  effect: "read" | "mutate"
): Promise<void> {
  if (!isControlPairEnforced()) return;
  if (effect === "read" || !isReachBearing(cap)) return;

  const grant = await getGrant(userId);
  if (!grant?.mayGrantReach) {
    log.warn("reach refused by the control pair: principal may not change agents", {
      principalId: userId,
      stationKey: station.stationKey,
      capability: cap,
    });
    throw new GrantReachDenied(userId, station.stationKey, cap);
  }

  // The node name, because a grant names a node as well as a station — station
  // keys repeat across the fleet.
  const [node] = await db
    .select({ name: nodes.name })
    .from(nodes)
    .where(eq(nodes.id, station.nodeId))
    .limit(1);

  const inScope =
    node !== undefined &&
    grantAllowsStation(grant, { nodeName: node.name, stationKey: station.stationKey });

  if (!inScope) {
    log.warn("reach refused by the control pair: station out of scope", {
      principalId: userId,
      node: node?.name,
      stationKey: station.stationKey,
      capability: cap,
    });
    throw new GrantReachDenied(userId, station.stationKey, cap);
  }
}

/**
 * Guard an act that names no station — minting an enrollment token today, the
 * credential broker later.
 *
 * There is no station to match a pattern against, so the rule is narrower: you
 * may grow a fleet only if your authority already spans it. The alternative —
 * the boolean alone — would let a principal scoped to one node add machines
 * indefinitely, which is the "register an agent" half of Decision 4's threat
 * restated.
 */
export async function requireFleetGrantReach(userId: string): Promise<void> {
  if (!isControlPairEnforced()) return;

  const grant = await getGrant(userId);
  const fleetWide =
    grant?.mayGrantReach === true &&
    grant.mayDispatch.some(
      (v) => v.startsWith(AGENTPOD_NS) && v.slice(AGENTPOD_NS.length).startsWith("*/")
    );

  if (!fleetWide) {
    log.warn("fleet-level reach refused by the control pair", { principalId: userId });
    throw new GrantReachDenied(userId, "fleet", null);
  }
}
