/**
 * Reading the workspace's runtimes, and which nodes run a fixed image.
 */

import { eq, isNotNull, ne } from "drizzle-orm";
import type { ProvisionedRuntime } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { tenantScope } from "../../db/tenant-scope";
import { provisionedRuntimes } from "../../db/schema/nodes";
import { getProvisionerUnguarded } from "../provisioner";
import { toContract } from "./rows";
import type { RuntimeScope } from "./rows";

/**
 * List the workspace's live provisioned runtimes.
 *
 * Destroyed rows stay in the DB for history but are excluded here: no action
 * can be taken on a destroyed runtime, so surfacing it gives the console a
 * permanent dead row.
 */
export async function listRuntimes(scope: RuntimeScope): Promise<ProvisionedRuntime[]> {
  const rows = await db
    .select()
    .from(provisionedRuntimes)
    .where(tenantScope(provisionedRuntimes, scope.tenantId, ne(provisionedRuntimes.status, "destroyed")));

  return rows.map(toContract);
}

/**
 * Get a single runtime in the workspace. Returns null if not found or in another workspace.
 */
export async function getRuntime(
  scope: RuntimeScope,
  id: string
): Promise<ProvisionedRuntime | null> {
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(tenantScope(provisionedRuntimes, scope.tenantId, eq(provisionedRuntimes.id, id)));

  return row ? toContract(row) : null;
}

/**
 * Nodes whose binary comes from the substrate's image, not from their disk (#349).
 *
 * A node backed by a driver that declares `imageBinding: "fixed"` cannot be
 * moved forward by self-update, and asking it to try is worse than refusing:
 * `selfupdate.Apply` swaps the binary and the agent exits to hand over to a
 * supervisor, which on a container substrate is simply the station stopping —
 * and the swapped binary would not have survived the restart anyway, because
 * the next start comes up from the image.
 *
 * Returns the set of node ids to leave alone. A set rather than a per-node
 * question because both callers — the single-node route and the fleet rollout —
 * want to decide before sending anything, and the fleet one would otherwise ask
 * once per node.
 */
export async function nodesWithFixedImage(tenantId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      nodeId: provisionedRuntimes.nodeId,
      provider: provisionedRuntimes.provider,
    })
    .from(provisionedRuntimes)
    .where(tenantScope(provisionedRuntimes, tenantId, isNotNull(provisionedRuntimes.nodeId)));

  const fixed = new Set<string>();
  for (const row of rows) {
    const provisioner = getProvisionerUnguarded(row.provider);
    // Unknown driver → not claimed as fixed. A refusal on a guess would block
    // an update that might work; the node's own answer still has the last word.
    if (provisioner?.manifest?.imageBinding === "fixed") fixed.add(row.nodeId!);
  }
  return fixed;
}
