/**
 * What the fleet wants a harness setting to be — declared, stored, resolved.
 *
 * This is the store half (comparing a declaration against what a station
 * actually has is Task 6). It has no opinion about the observed side at all:
 * a station's live value is read from the node and never cached in this
 * table, because a cached observation is a claim about a machine that may
 * have changed since — the class of bug this whole design exists to end.
 *
 * `tenantId` is REQUIRED on every exported function here, never optional.
 * Every hub query is tenant-scoped, and an optional tenant on a write is a
 * cross-tenant write — the most expensive defect class in this repo.
 */
import { eq, isNull, SQL } from "drizzle-orm";
import { db } from "../db/drizzle";
import { declaredHarnessConfig } from "../db/schema/harness-config";
import { tenantScope } from "../db/tenant-scope";
import { prefixedId } from "../utils/ids";

/** A level a declaration can target: a station, a node, or (both null) the fleet. */
export interface Level {
  stationId: string | null;
  nodeId: string | null;
}

export type ResolvedLevel = "station" | "node" | "fleet";

export interface Resolved {
  value: unknown;
  level: ResolvedLevel;
}

/** Two levels is not a level. Checked here because no index can express it. */
function assertOneLevel(l: Level): void {
  if (l.stationId !== null && l.nodeId !== null) {
    throw new Error("a declaration targets one level: station, node, or fleet");
  }
}

/**
 * The predicate that identifies the single row for one (tenant, setting, level).
 *
 * Built through `tenantScope()` rather than a bare `eq(tenantId, …)` so the
 * tenant predicate is bound first and tenantId is validated as a real
 * AgentPod tenant id (`fleet_<20 hex>`) — the same guard every other scoped
 * query in this hub goes through (`db/tenant-scope.ts`).
 */
function levelWhere(input: Level & { settingId: string; tenantId: string }): SQL {
  return tenantScope(
    declaredHarnessConfig,
    input.tenantId,
    eq(declaredHarnessConfig.settingId, input.settingId),
    input.stationId === null
      ? isNull(declaredHarnessConfig.stationId)
      : eq(declaredHarnessConfig.stationId, input.stationId),
    input.nodeId === null
      ? isNull(declaredHarnessConfig.nodeId)
      : eq(declaredHarnessConfig.nodeId, input.nodeId),
  );
}

/**
 * Declare what the fleet wants a setting to be, at one level.
 *
 * Replaces rather than duplicates: a second `declare()` at the same level
 * overwrites the first. Implemented as delete-then-insert inside one
 * transaction rather than an upsert, because Postgres never treats a NULL
 * `stationId`/`nodeId` as a conflict against another NULL — the fleet level
 * (both null) and the node level (`stationId` null) would otherwise insert a
 * second row instead of replacing the first.
 */
export async function declare(
  input: Level & { settingId: string; value: unknown; tenantId: string; declaredBy: string },
): Promise<void> {
  assertOneLevel(input);
  await db.transaction(async (tx) => {
    await tx.delete(declaredHarnessConfig).where(levelWhere(input));
    await tx.insert(declaredHarnessConfig).values({
      id: prefixedId("dcfg"),
      tenantId: input.tenantId,
      settingId: input.settingId,
      stationId: input.stationId,
      nodeId: input.nodeId,
      value: input.value,
      declaredBy: input.declaredBy,
    });
  });
}

/** Remove a declaration at one level. A level with no declaration is a no-op. */
export async function undeclare(
  input: Level & { settingId: string; tenantId: string },
): Promise<void> {
  assertOneLevel(input);
  await db.delete(declaredHarnessConfig).where(levelWhere(input));
}

/**
 * Every setting declared for this station, most specific declaration
 * winning: station, then its node, then the fleet — and which of those three
 * levels won, because Task 6 refuses a station-scoped declaration of a
 * `user`-scoped setting and can only know the declaration was made at
 * station level if this function says so.
 *
 * Returns only what was declared. A setting nobody declared is ABSENT from
 * the result rather than carrying a default — this system has no opinion
 * about a setting the operator never mentioned.
 */
export async function resolveFor(
  stationId: string,
  nodeId: string,
  tenantId: string,
): Promise<Record<string, Resolved>> {
  const rows = await db
    .select()
    .from(declaredHarnessConfig)
    .where(tenantScope(declaredHarnessConfig, tenantId));

  const rank = (r: (typeof rows)[number]): { score: number; level: ResolvedLevel } | null => {
    if (r.stationId !== null) return r.stationId === stationId ? { score: 3, level: "station" } : null;
    if (r.nodeId !== null) return r.nodeId === nodeId ? { score: 2, level: "node" } : null;
    return { score: 1, level: "fleet" };
  };

  const best: Record<string, number> = {};
  const out: Record<string, Resolved> = {};
  for (const r of rows) {
    const ranked = rank(r);
    if (ranked === null) continue; // another station's or another node's declaration
    if ((best[r.settingId] ?? 0) < ranked.score) {
      best[r.settingId] = ranked.score;
      out[r.settingId] = { value: r.value, level: ranked.level };
    }
  }
  return out;
}
