import { and, eq, isNull } from "drizzle-orm";
import type { SalaamApprovalRule, SalaamAuthority } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { agentApprovalRules as rules } from "../db/schema/agent-approval-rules";
import { stations } from "../db/schema/stations";

export const APPROVAL_RULE_SCOPES = ["workspace-write"] as const;
export type ApprovalRuleScope = (typeof APPROVAL_RULE_SCOPES)[number];

/**
 * The live rules Salaam receives for this binding: the station's rules for its current occupant,
 * strict board work only. Undefined when there are none, so the field stays off the wire (an older
 * node refuses unknown fields) and Salaam reads its absence as "no rules": a revoked last rule
 * still ends at the next renewal.
 */
export async function approvalRulesFor(
  binding: SalaamAuthority,
): Promise<SalaamApprovalRule[] | undefined> {
  if (binding.run.source !== "superpipeline") return undefined;
  const [station] = await db
    .select({ tenantId: stations.tenantId })
    .from(stations)
    .where(eq(stations.id, binding.station_id));
  if (!station) return undefined;
  const live = await db
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.tenantId, station.tenantId),
        eq(rules.stationId, binding.station_id),
        eq(rules.principalId, binding.principal_id),
        isNull(rules.revokedAt),
      ),
    );
  if (!live.length) return undefined;
  return live
    .map((r) => ({ id: r.id, scope: r.scope as ApprovalRuleScope, set_by: r.createdBy }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 16);
}
