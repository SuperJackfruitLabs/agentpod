/**
 * A provisioned runtime's row and what the service hands back for it: the contract shape, the
 * workspace scope a call may reach, the id format, and the duration wording every reason uses.
 */

import type { ProvisionedRuntime } from "@agentpod/contract";
import type { provisionedRuntimes } from "../../db/schema/nodes";

export const prefixedId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export type RuntimeRow = typeof provisionedRuntimes.$inferSelect;

export function toContract(row: RuntimeRow): ProvisionedRuntime {
  return {
    id: row.id,
    ownerId: row.userId,
    provider: row.provider as ProvisionedRuntime["provider"],
    externalId: row.externalId ?? null,
    status: row.status as ProvisionedRuntime["status"],
    nodeId: row.nodeId ?? null,
    name: row.name,
    resourceTier: row.resourceTier as ProvisionedRuntime["resourceTier"],
    harness: (row.harness ?? "none") as ProvisionedRuntime["harness"],
    runtime: row.runtime ?? null,
    statusReason: row.statusReason ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Whose runtimes a call may reach: the workspace's (workspace authority spec, W4). A runtime
 * belongs to its tenant; `user_id` records who provisioned it. An object, so a caller still passing
 * a user id is a type error rather than a silent "not found".
 */
export interface RuntimeScope {
  tenantId: string;
}

export const humanMs = (ms: number) =>
  ms >= 3_600_000
    ? `${Math.round(ms / 3_600_000)}h`
    : ms >= 60_000
      ? `${Math.round(ms / 60_000)}m`
      : `${Math.round(ms / 1000)}s`;
