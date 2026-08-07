import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { nodes, provisionedRuntimes } from "../db/schema/nodes";
import type { NodeSummary } from "@agentpod/contract";
import { getLatestAgentVersion, isNewerVersion } from "./agent-version";

export type NodeWithProvisioning = NodeSummary & {
  provisioned: { runtimeId: string; provider: string } | null;
};

/**
 * Pure helper — annotates a list of node objects with latestVersion and
 * updateAvailable without touching the database or the network.
 *
 * Exported so it can be unit-tested without a live database.
 */
export function annotateWithVersion<
  T extends { agentVersion: string | null }
>(
  rows: T[],
  latestVersion: string | null
): (T & { latestVersion: string | null; updateAvailable: boolean })[] {
  return rows.map((n) => ({
    ...n,
    latestVersion,
    updateAvailable:
      n.agentVersion != null &&
      latestVersion != null &&
      isNewerVersion(latestVersion, n.agentVersion),
  }));
}

export async function listNodes(userId: string): Promise<NodeWithProvisioning[]> {
  // Left-join provisioned_runtimes on node_id so each node carries its
  // provisioned-runtime info (null if the node was attached manually).
  const rows = await db
    .select({
      id: nodes.id,
      name: nodes.name,
      hostname: nodes.hostname,
      os: nodes.os,
      arch: nodes.arch,
      cpuCount: nodes.cpuCount,
      agentVersion: nodes.agentVersion,
      status: nodes.status,
      lastSeenAt: nodes.lastSeenAt,
      createdAt: nodes.createdAt,
      runtimeId: provisionedRuntimes.id,
      runtimeProvider: provisionedRuntimes.provider,
    })
    .from(nodes)
    .leftJoin(provisionedRuntimes, eq(provisionedRuntimes.nodeId, nodes.id))
    .where(eq(nodes.userId, userId));

  // Resolve latest version once for the whole batch.
  const latestVersion = await getLatestAgentVersion();

  const mapped = rows.map((n) => ({
    id: n.id,
    name: n.name,
    hostname: n.hostname,
    os: n.os,
    arch: n.arch,
    cpuCount: n.cpuCount,
    agentVersion: n.agentVersion ?? null,
    status: n.status,
    lastSeenAt: n.lastSeenAt ? n.lastSeenAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
    provisioned:
      n.runtimeId && n.runtimeProvider
        ? { runtimeId: n.runtimeId, provider: n.runtimeProvider }
        : null,
  }));

  return annotateWithVersion(mapped, latestVersion);
}

export async function setNodeStatus(
  nodeId: string,
  status: "online" | "offline"
) {
  // lastSeenAt means "last actual contact" — only online transitions bump it.
  await db
    .update(nodes)
    .set(status === "online" ? { status, lastSeenAt: new Date() } : { status })
    .where(eq(nodes.id, nodeId));
}

/**
 * Boot-time reconciliation: any row still marked online is an orphan from a
 * previous hub process (no socket can exist yet). Returns the flipped count.
 */
export async function resetOrphanedOnlineNodes(): Promise<number> {
  const rows = await db
    .update(nodes)
    .set({ status: "offline" })
    .where(eq(nodes.status, "online"))
    .returning({ id: nodes.id });
  return rows.length;
}

export async function setNodeAgentVersion(
  nodeId: string,
  agentVersion: string | null
) {
  await db
    .update(nodes)
    .set({ agentVersion })
    .where(eq(nodes.id, nodeId));
}
