/**
 * Destroying a runtime: the driver's destroy(), the destroyed row, and its node removed.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { tenantScope } from "../../db/tenant-scope";
import { provisionedRuntimes, nodes } from "../../db/schema/nodes";
import { stations } from "../../db/schema/stations";
import { markStationTreeRevoking } from "../stations";
import { getProvisionerUnguarded } from "../provisioner";
import type { RuntimeScope } from "./rows";

/**
 * Permanently destroy a runtime and mark it destroyed in the DB.
 * Throws 404 if not found or in another workspace.
 * Throws 502 if the driver destroy() fails.
 */
export async function destroyRuntime(scope: RuntimeScope, id: string): Promise<void> {
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(tenantScope(provisionedRuntimes, scope.tenantId, eq(provisionedRuntimes.id, id)));

  if (!row) {
    throw Object.assign(new Error("runtime not found"), { status: 404 });
  }

  if (row.externalId) {
    const provisioner = getProvisionerUnguarded(row.provider);
    if (provisioner) {
      try {
        await provisioner.destroy(row.externalId);
      } catch (err) {
        throw Object.assign(err as Error, { status: 502 });
      }
    }
    // If no provisioner is registered (driver removed), skip the driver call
    // but still mark the row destroyed — don't leave it dangling.
  }

  await db
    .update(provisionedRuntimes)
    .set({ status: "destroyed", updatedAt: new Date() })
    .where(eq(provisionedRuntimes.id, id));

  // Remove the provisioned node so it disappears from the fleet — a destroyed
  // runtime must not linger as a ghost "offline" node. stations cascade-delete,
  // and provisioned_runtimes.node_id is FK-nulled (onDelete: set null), so the
  // runtime row remains for history with a null node_id. station_audit rows are
  // kept (no FK) but won't surface in the UI once their stations are gone.
  if (row.nodeId) {
    const nodeId = row.nodeId;
    // The cascade takes the stations with it; their forge API grants go to `revoking` in the same
    // transaction (the FK nulls their station_id) so the reconcile sweep revokes the tokens.
    await db.transaction(async (tx) => {
      const gone = await tx
        .select({ id: stations.id })
        .from(stations)
        .where(eq(stations.nodeId, nodeId));
      // Each station's descendants too: they cascade with it, wherever their node is.
      for (const st of gone) await markStationTreeRevoking(tx, st.id, "node-removed");
      await tx.delete(nodes).where(eq(nodes.id, nodeId));
    });
  }
}
