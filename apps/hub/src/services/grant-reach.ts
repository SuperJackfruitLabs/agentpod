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

import { and, eq } from "drizzle-orm";
import { Capability } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { stations } from "../db/schema";
import { principalIdentities } from "../db/schema/identities";
import { getGrant, grantAllowsPrincipal } from "./grants";
import { principalForUser } from "./principals";
import { isUserAdmin } from "../models/admin-users";
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
 * dispatch scope covers this station. One scope check, shared with dispatch, so
 * the two can never disagree about what a grant means — `grantAllowsPrincipal`
 * is the same function `acp.createSession` calls.
 *
 * `userId` is a Better Auth user id — every caller reaches this through a
 * console route holding a session, never a principal id obtained elsewhere —
 * and is resolved to a principal before either `getGrant` or the station scope
 * check, both of which are keyed by principal id now.
 */
export async function requireGrantReach(
  userId: string,
  station: { nodeId: string; stationKey: string },
  cap: Capability,
  effect: "read" | "mutate"
): Promise<void> {
  if (!isControlPairEnforced()) return;
  if (effect === "read" || !isReachBearing(cap)) return;

  const principal = await principalForUser(userId);
  if (!principal) {
    log.warn("reach refused by the control pair: no principal for this caller", {
      userId,
      stationKey: station.stationKey,
      capability: cap,
    });
    throw new GrantReachDenied(userId, station.stationKey, cap);
  }

  const grant = await getGrant(principal.id);
  if (!grant?.mayGrantReach) {
    log.warn("reach refused by the control pair: principal may not change agents", {
      principalId: principal.id,
      stationKey: station.stationKey,
      capability: cap,
    });
    throw new GrantReachDenied(principal.id, station.stationKey, cap);
  }

  // The station's OCCUPYING PRINCIPAL, not the station itself — a grant names
  // an agent, and (nodeId, stationKey) is the unique index that gets there
  // without a second copy of the id in every caller's hands.
  const [row] = await db
    .select({ principalId: stations.principalId })
    .from(stations)
    .where(and(eq(stations.nodeId, station.nodeId), eq(stations.stationKey, station.stationKey)))
    .limit(1);

  const inScope = row !== undefined && grantAllowsPrincipal(grant, row.principalId);

  if (!inScope) {
    log.warn("reach refused by the control pair: station out of scope", {
      principalId: principal.id,
      stationKey: station.stationKey,
      capability: cap,
    });
    throw new GrantReachDenied(principal.id, station.stationKey, cap);
  }
}

/**
 * Guard issuing a station its own credentials.
 *
 * No capability is consulted, because this is not a capability: handing an agent
 * an access token to a homeserver IS granting it reach, by the definition in
 * `charter` → decisions/2026-08-15-granting-reach-is-changing-an-agent.md. The
 * scope half is the same as everywhere else — you may only do it to an agent
 * your dispatch grant already covers.
 */
export async function requireIssueCredentials(
  userId: string,
  station: { nodeId: string; stationKey: string }
): Promise<void> {
  if (!isControlPairEnforced()) return;

  const principal = await principalForUser(userId);
  if (!principal) {
    log.warn("credential issue refused: no principal for this caller", {
      userId,
      stationKey: station.stationKey,
    });
    throw new GrantReachDenied(userId, station.stationKey, "credentials");
  }

  const grant = await getGrant(principal.id);
  if (!grant?.mayGrantReach) {
    log.warn("credential issue refused: principal may not change agents", {
      principalId: principal.id,
      stationKey: station.stationKey,
    });
    throw new GrantReachDenied(principal.id, station.stationKey, "credentials");
  }

  const [row] = await db
    .select({ principalId: stations.principalId })
    .from(stations)
    .where(and(eq(stations.nodeId, station.nodeId), eq(stations.stationKey, station.stationKey)))
    .limit(1);

  const inScope = row !== undefined && grantAllowsPrincipal(grant, row.principalId);

  if (!inScope) {
    log.warn("credential issue refused: station out of scope", {
      principalId: principal.id,
      stationKey: station.stationKey,
    });
    throw new GrantReachDenied(principal.id, station.stationKey, "credentials");
  }
}

/**
 * Is this principal an admin?
 *
 * Resolves through the same identity the login session came from —
 * `principal_identities` where `system = "better-auth"` — and asks the
 * question the Better Auth admin plugin already answers for `/api/admin/*`:
 * is `role` on that `user` row `"admin"`. No second notion of admin is
 * introduced here; a principal with no linked Better Auth identity (an agent,
 * a service) is simply not an admin.
 */
async function isAdminPrincipal(principalId: string): Promise<boolean> {
  const [identity] = await db
    .select({ externalId: principalIdentities.externalId })
    .from(principalIdentities)
    .where(
      and(
        eq(principalIdentities.principalId, principalId),
        eq(principalIdentities.system, "better-auth")
      )
    )
    .limit(1);

  if (!identity) return false;
  return isUserAdmin(identity.externalId);
}

/**
 * Growing a fleet is an admin act.
 *
 * This used to require `mayGrantReach` plus a dispatch value whose node half was
 * `*` — "you may grow a fleet only if your authority already spans it". With no
 * wildcards there is no way to say "spans", and
 * 2026-08-15-granting-reach-is-changing-an-agent explicitly rejected a second
 * scoped list as the asymmetric-grant hazard restated. Admin is the honest
 * remaining answer, and /api/admin/grants is already guarded that way.
 */
export async function requireFleetGrantReach(principalId: string): Promise<void> {
  if (!isControlPairEnforced()) return;
  if (await isAdminPrincipal(principalId)) return;
  log.warn("fleet-level reach refused: not an admin", { principalId });
  throw new GrantReachDenied(principalId, "fleet", null);
}
