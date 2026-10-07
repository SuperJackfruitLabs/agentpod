/**
 * Removing a node: a retired machine leaving the fleet.
 *
 * Until this existed an enrolled machine stayed listed forever. A provisioned
 * runtime's node already went away through `destroyRuntime`; this is the same
 * act for a machine somebody enrolled by hand.
 *
 * What it does, in order:
 *   1. Refuses what this is the wrong tool for (see `RemoveNodeRefusalCode`):
 *      a runtime's node (`fleet runtimes rm` destroys both), a node with a
 *      bridge-roster row on one of its stations (the row holds a credential and
 *      `bridge_agents` restricts the delete, so it is removed on purpose first),
 *      and a connected node unless the caller said `force`.
 *   2. Unregisters every station through `unadopt` — the same path "Remove
 *      station" takes, so skill-operation history and Matrix routing records go
 *      the same way (by cascade from the station row).
 *   3. Drops the node's own harness-config declarations and exemptions. They
 *      have no foreign key and would otherwise outlive the node as rows naming
 *      nothing.
 *   4. Deletes the node row. That is the credential revocation: the row holds
 *      the only hash the gateway verifies `<nodeId>:<nodeSecret>` against, so a
 *      machine that dials back is refused, and joining again needs a fresh
 *      `fleet invite` token. Its original token was one-time and is spent.
 *   5. Cuts a live session, if there is one, and fails anything in flight.
 *
 * Kept, deliberately: the station audit trail (no foreign key, history), the
 * Matrix node space and rooms on the homeserver (Remove station keeps Matrix
 * messages too), and each station's agent identity and grants.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { RemoveNodeRefusalCode, RemoveNodeResponse } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { nodes, provisionedRuntimes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";
import { bridgeAgents } from "../db/schema/bridge";
import { declaredHarnessConfig } from "../db/schema/harness-config";
import { harnessConfigOptOut } from "../db/schema/harness-config-ops";
import { unadopt } from "./station-registry";
import { connectionManager } from "./connection-manager";
import { dropNode } from "./broker";
import { clearNode } from "./health-cache";

/** The close code a removed node's socket is ended with (policy violation). */
export const NODE_REMOVED_CLOSE_CODE = 1008;
export const NODE_REMOVED_CLOSE_REASON = "node removed";

export type RemoveNodeOutcome =
  | { kind: "not_found" }
  | {
      kind: "refused";
      code: RemoveNodeRefusalCode;
      error: string;
      runtimeId?: string;
      bridgeAgents?: string[];
    }
  | { kind: "removed"; result: RemoveNodeResponse };

/** Does `userId` own `nodeId`? */
export async function ownsNode(userId: string, nodeId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)));
  return row !== undefined;
}

/**
 * Remove `nodeId` if `userId` owns it. A node someone else owns is answered
 * exactly like one that does not exist, so its id is not confirmed to anyone.
 */
export async function removeNode(
  userId: string,
  nodeId: string,
  opts: { force: boolean }
): Promise<RemoveNodeOutcome> {
  const [node] = await db
    .select({ id: nodes.id, name: nodes.name, status: nodes.status })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)));
  if (!node) return { kind: "not_found" };

  const [runtime] = await db
    .select({ id: provisionedRuntimes.id, name: provisionedRuntimes.name })
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.nodeId, nodeId))
    .limit(1);
  if (runtime) {
    return {
      kind: "refused",
      code: "provisioned",
      runtimeId: runtime.id,
      error:
        `This node belongs to the provisioned runtime "${runtime.name}" (${runtime.id}). ` +
        `Remove the runtime instead — \`fleet runtimes rm ${runtime.id}\`, or Destroy on this page — ` +
        "which destroys its container and removes the node with it.",
    };
  }

  const owned = await db
    .select({ id: stations.id, stationKey: stations.stationKey, userId: stations.userId })
    .from(stations)
    .where(eq(stations.nodeId, nodeId));

  if (owned.length > 0) {
    const roster = await db
      .select({ key: bridgeAgents.key })
      .from(bridgeAgents)
      .where(inArray(bridgeAgents.stationId, owned.map((s) => s.id)));
    if (roster.length > 0) {
      const keys = roster.map((r) => r.key).sort();
      return {
        kind: "refused",
        code: "bridged",
        bridgeAgents: keys,
        error:
          `Bridge agent${keys.length === 1 ? "" : "s"} ${keys.join(", ")} still run${keys.length === 1 ? "s" : ""} ` +
          "on a station here. Remove the roster entr" + (keys.length === 1 ? "y" : "ies") +
          ` first (\`fleet bridge rm ${keys[0]}\`), then remove the node.`,
      };
    }
  }

  const connected = connectionManager.isOnline(nodeId) || node.status === "online";
  if (connected && !opts.force) {
    return {
      kind: "refused",
      code: "online",
      error:
        "This node is connected. Removing it disconnects it, and it cannot rejoin without " +
        "re-enrolling with a fresh `fleet invite` token. Retry with force to remove it anyway.",
    };
  }

  for (const s of owned) await unadopt(s.userId, s.id);

  await db.delete(declaredHarnessConfig).where(eq(declaredHarnessConfig.nodeId, nodeId));
  await db.delete(harnessConfigOptOut).where(eq(harnessConfigOptOut.nodeId, nodeId));
  await db.delete(nodes).where(eq(nodes.id, nodeId));

  // After the row is gone, so a reconnect racing this already fails its
  // credential check. The socket's own onClose sees it is no longer current
  // and leaves the teardown to here.
  const disconnected = connectionManager.disconnect(
    nodeId,
    NODE_REMOVED_CLOSE_CODE,
    NODE_REMOVED_CLOSE_REASON
  );
  clearNode(nodeId);
  dropNode(nodeId);

  return {
    kind: "removed",
    result: {
      ok: true,
      node: { id: node.id, name: node.name },
      stationsRemoved: owned.map((s) => ({ id: s.id, stationKey: s.stationKey })),
      disconnected,
    },
  };
}
