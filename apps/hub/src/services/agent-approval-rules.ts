import { and, eq, isNull } from "drizzle-orm";
import type { SalaamApprovalRule, SalaamAuthority } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { agentApprovalRules as rules, type AgentApprovalRule } from "../db/schema/agent-approval-rules";
import { stations } from "../db/schema/stations";
import { tenants } from "../db/schema/tenants";
import { recordAudit } from "./audit";
import { orgPlaneClient } from "./org-plane/client";

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

type StationRow = typeof stations.$inferSelect;

/**
 * Set the station occupant's standing rule (idempotent: an existing live rule is returned). The one
 * setter behind the console switch and the approval's "Always allow" button, audited either way.
 */
export async function setApprovalRule(
  station: StationRow,
  scope: ApprovalRuleScope,
  actor: string,
  via: "console" | "approval",
): Promise<{ rule: AgentApprovalRule; created: boolean }> {
  if (!station.principalId) throw new NoOccupant();
  const live = and(
    eq(rules.stationId, station.id),
    eq(rules.principalId, station.principalId),
    isNull(rules.revokedAt),
    eq(rules.scope, scope),
  );
  const [existing] = await db.select().from(rules).where(live);
  if (existing) return { rule: existing, created: false };
  const [created] = await db
    .insert(rules)
    .values({
      id: crypto.randomUUID(),
      tenantId: station.tenantId,
      stationId: station.id,
      principalId: station.principalId,
      scope,
      createdBy: actor,
    })
    .onConflictDoNothing()
    .returning();
  const rule = created ?? (await db.select().from(rules).where(live))[0]!;
  const audit = await recordAudit(db, {
    tenantId: station.tenantId,
    userId: actor,
    nodeId: station.nodeId,
    stationKey: station.stationKey,
    verb: "approval-rule.set",
    params: { actor, ruleId: rule.id, scope: rule.scope, via },
  });
  await audit.done("ok");
  return { rule, created: !!created };
}
export class NoOccupant extends Error {
  constructor() {
    super("This station has no agent to set a rule for.");
  }
}

/** Why an "Always allow" answer was not forwarded, in words a person can act on. */
export class AlwaysAllowRefused extends Error {}

/**
 * The guard behind the approval's "Always allow" (operator ruling 2026-10-28). The board's claim
 * about the answerer is not trusted: the answerer's role is re-read from the org plane by their own
 * principal, and must be owner or admin of this station's workspace. Then the workspace-write rule
 * is set through the same setter as the console switch. Any failure refuses the answer, so nobody
 * is told a rule exists when it does not.
 */
export async function alwaysAllowFromAnswer(o: {
  tenantId: string;
  stationId: string;
  answeredBy: string;
}): Promise<AgentApprovalRule> {
  const [station] = await db
    .select()
    .from(stations)
    .where(and(eq(stations.id, o.stationId), eq(stations.tenantId, o.tenantId)));
  const [tenant] = await db.select({ org: tenants.externalId }).from(tenants).where(eq(tenants.id, o.tenantId));
  let person;
  try {
    person = await orgPlaneClient().getPrincipal(o.answeredBy);
  } catch {
    throw new AlwaysAllowRefused("Always allow could not check who answered; nothing was approved.");
  }
  if (
    !station ||
    !tenant?.org ||
    !person ||
    person.kind !== "human" ||
    person.suspended ||
    person.organizationId !== tenant.org ||
    (person.role !== "owner" && person.role !== "admin")
  )
    throw new AlwaysAllowRefused("Always allow needs a workspace owner or admin; nothing was approved.");
  try {
    return (await setApprovalRule(station, "workspace-write", person.id, "approval")).rule;
  } catch {
    throw new AlwaysAllowRefused("Always allow could not be set; nothing was approved.");
  }
}
