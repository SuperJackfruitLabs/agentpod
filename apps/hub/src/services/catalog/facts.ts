/**
 * What the hub already knows about each station of a workspace, read from its own tables. Never a
 * live probe of a node (a read the scheduler makes every pass must not wait on a machine) and
 * never a secret: a roster row's board-tools token is read as present or absent, and a forge
 * grant as its provider, instance and state.
 *
 * Sources:
 * - the station row: harness, occupant, the operator's MCP proxy declaration;
 * - `provisioned_runtimes`: the newest live runtime AgentPod provisioned for the station's node;
 * - `acp_runs.fingerprint`: the newest run that named a model, and who reported it;
 * - `skill_operations`: the latest applied managed install or rollback per skill profile, and the
 *   trusted release its archive belongs to, if any;
 * - `bridge_agents`: an enabled row whose run-scoped board-tools token is set;
 * - `station_forge_api_grants`: SuperToolkit's broker on the station, by the grants delivered to it.
 */
import { and, desc, eq, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { acpRuns } from "../../db/schema/acp";
import { bridgeAgents } from "../../db/schema/bridge";
import { stationForgeApiGrants, type ForgeGrantState } from "../../db/schema/forge-api-grants";
import { provisionedRuntimes } from "../../db/schema/nodes";
import { skillArtifacts, skillOperations, trustedSkillReleaseArtifacts, trustedSkillReleases } from "../../db/schema/skills";
import { stations } from "../../db/schema/stations";
import type { StationFacts } from "./types";

/** Forge grant states that reach nothing. */
const DEAD_GRANTS: ForgeGrantState[] = ["revoked", "revoking", "failed"];

/** A managed skill plan's selected generation, or null; tolerant of any other plan shape. */
function generationOf(plan: unknown): string | null {
  const after = typeof plan === "object" && plan !== null && "after" in plan ? plan.after : null;
  const sha = typeof after === "object" && after !== null && "archiveSHA256" in after ? after.archiveSHA256 : null;
  return typeof sha === "string" ? sha : null;
}

/** Facts for the workspace's stations: every one, or just `only` when given. */
export async function stationFactsFor(tenantId: string, only?: string[]): Promise<StationFacts[]> {
  const rows = await db
    .select({
      stationId: stations.id,
      principalId: stations.principalId,
      harness: stations.harness,
      nodeId: stations.nodeId,
      mcpProxy: stations.mcpProxy,
    })
    .from(stations)
    .where(and(eq(stations.tenantId, tenantId), only ? inArray(stations.id, only) : undefined))
    .orderBy(stations.id);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.stationId);
  const nodeIds = [...new Set(rows.map((r) => r.nodeId))];

  const [runtimes, prints, ops, tools, grants] = await Promise.all([
    db
      .selectDistinctOn([provisionedRuntimes.nodeId], {
        nodeId: provisionedRuntimes.nodeId,
        provider: provisionedRuntimes.provider,
        runtime: provisionedRuntimes.runtime,
      })
      .from(provisionedRuntimes)
      .where(
        and(
          eq(provisionedRuntimes.tenantId, tenantId),
          inArray(provisionedRuntimes.nodeId, nodeIds),
          ne(provisionedRuntimes.status, "destroyed"),
        ),
      )
      .orderBy(provisionedRuntimes.nodeId, desc(provisionedRuntimes.createdAt)),
    db
      .selectDistinctOn([acpRuns.stationId], { stationId: acpRuns.stationId, fingerprint: acpRuns.fingerprint })
      .from(acpRuns)
      .where(
        and(
          eq(acpRuns.tenantId, tenantId),
          inArray(acpRuns.stationId, ids),
          sql`coalesce(${acpRuns.fingerprint}->>'model', '') <> ''`,
        ),
      )
      .orderBy(acpRuns.stationId, desc(acpRuns.startedAt)),
    db
      .selectDistinctOn([skillOperations.stationId, skillOperations.profile], {
        stationId: skillOperations.stationId,
        profile: skillOperations.profile,
        plan: skillOperations.plan,
      })
      .from(skillOperations)
      .where(
        and(
          eq(skillOperations.tenantId, tenantId),
          inArray(skillOperations.stationId, ids),
          eq(skillOperations.kind, "managed"),
          eq(skillOperations.state, "applied"),
        ),
      )
      .orderBy(skillOperations.stationId, skillOperations.profile, desc(skillOperations.updatedAt)),
    db
      .selectDistinct({ stationId: bridgeAgents.stationId })
      .from(bridgeAgents)
      .where(
        and(
          eq(bridgeAgents.tenantId, tenantId),
          inArray(bridgeAgents.stationId, ids),
          eq(bridgeAgents.enabled, true),
          isNotNull(bridgeAgents.mcpTokenEncrypted),
        ),
      ),
    db
      .select({
        stationId: stationForgeApiGrants.stationId,
        provider: stationForgeApiGrants.provider,
        instance: stationForgeApiGrants.instance,
        state: stationForgeApiGrants.state,
      })
      .from(stationForgeApiGrants)
      .where(
        and(
          eq(stationForgeApiGrants.tenantId, tenantId),
          inArray(stationForgeApiGrants.stationId, ids),
          notInArray(stationForgeApiGrants.state, DEAD_GRANTS),
        ),
      ),
  ]);

  const shas = [...new Set(ops.map((o) => generationOf(o.plan)).filter((s): s is string => s !== null))];
  const releases =
    shas.length === 0
      ? []
      : await db
          .selectDistinctOn([skillArtifacts.archiveSHA256], {
            sha: skillArtifacts.archiveSHA256,
            version: trustedSkillReleases.version,
          })
          .from(skillArtifacts)
          .innerJoin(
            trustedSkillReleaseArtifacts,
            and(
              eq(trustedSkillReleaseArtifacts.artifactId, skillArtifacts.id),
              eq(trustedSkillReleaseArtifacts.tenantId, skillArtifacts.tenantId),
            ),
          )
          .innerJoin(
            trustedSkillReleases,
            and(
              eq(trustedSkillReleases.id, trustedSkillReleaseArtifacts.releaseId),
              eq(trustedSkillReleases.tenantId, trustedSkillReleaseArtifacts.tenantId),
            ),
          )
          .where(and(eq(skillArtifacts.tenantId, tenantId), inArray(skillArtifacts.archiveSHA256, shas)))
          .orderBy(skillArtifacts.archiveSHA256, desc(trustedSkillReleases.createdAt));

  const runtimeByNode = new Map(runtimes.map((r) => [r.nodeId, r]));
  const printByStation = new Map(prints.map((p) => [p.stationId, p.fingerprint]));
  const versionBySha = new Map(releases.map((r) => [r.sha, r.version]));
  const withTools = new Set(tools.map((t) => t.stationId));

  return rows.map((r): StationFacts => {
    const rt = runtimeByNode.get(r.nodeId);
    const fp = printByStation.get(r.stationId);
    return {
      stationId: r.stationId,
      principalId: r.principalId,
      harness: r.harness,
      runtime: rt ? { provider: rt.provider, runtime: rt.runtime } : null,
      fingerprint: fp ? { model: fp.model, harnessVersion: fp.harness_version ?? "", reportedBy: fp.reported_by } : null,
      skills: ops
        .filter((o) => o.stationId === r.stationId)
        .flatMap((o) => {
          const sha = generationOf(o.plan);
          return sha === null ? [] : [{ profile: o.profile, releaseVersion: versionBySha.get(sha) ?? null }];
        }),
      mcpProxy: r.mcpProxy,
      boardTools: withTools.has(r.stationId),
      forgeGrants: grants
        .filter((g) => g.stationId === r.stationId)
        .map((g) => ({ provider: g.provider, instance: g.instance, state: g.state }))
        .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.instance.localeCompare(b.instance)),
    };
  });
}
