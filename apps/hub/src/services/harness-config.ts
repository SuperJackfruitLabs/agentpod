/**
 * What the fleet wants a harness setting to be — declared, stored, resolved —
 * and `compare`, which weighs that against what a station actually has.
 * The store half has no opinion about the observed side at all: a station's
 * live value is read from the node and never cached in this table, because a
 * cached observation is a claim about a machine that may have changed since
 * — the class of bug this whole design exists to end.
 *
 * `tenantId` is REQUIRED on every exported function here, never optional.
 * Every hub query is tenant-scoped, and an optional tenant on a write is a
 * cross-tenant write — the most expensive defect class in this repo.
 */
import { eq, isNull, SQL } from "drizzle-orm";
import type { ConfigObservation, ConfigSetting, ConfigValue } from "@agentpod/contract";
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

/**
 * Compare a station's observed values with what was declared for it.
 *
 * Only settings that were DECLARED are reported: this system has no opinion
 * about a setting nobody mentioned, and reporting one would make the drift
 * list a list of every setting in the fleet.
 *
 * `declaredAtStationLevel` is how the caller carries forward the `level` that
 * `resolveFor` attached to its resolution, without folding it into the bare
 * declared value — the level is load-bearing: `out-of-scope` fires only when
 * the winning declaration was made at STATION level for a setting whose
 * document is not per-station (`scope !== "profile"`).
 */
export function compare(args: {
  stationId: string;
  values: ConfigValue[];
  settings: ConfigSetting[];
  declared: Record<string, unknown>;
  declaredAtStationLevel?: Set<string>;
}): ConfigObservation[] {
  const byId = new Map(args.settings.map((s) => [s.id, s]));
  const stationLevel = args.declaredAtStationLevel ?? new Set<string>();
  const out: ConfigObservation[] = [];

  for (const v of args.values) {
    if (!(v.settingId in args.declared)) continue; // undeclared: no opinion, not reported
    const declared = args.declared[v.settingId];
    const setting = byId.get(v.settingId);
    const row = { settingId: v.settingId, stationId: args.stationId, declared, observed: v.observed };

    // Scope first: a declaration that cannot be honoured is not drift, and
    // calling it "drifted" would invite an apply that must then refuse.
    if (setting && setting.scope !== "profile" && stationLevel.has(v.settingId)) {
      out.push({
        ...row,
        state: "out-of-scope",
        reason: `${v.settingId} is ${setting.scope}-scoped: declaring it for one station would change its siblings on the same host`,
      });
      continue;
    }

    // `unreadable` must never collapse into `absent`: a document that could
    // not be read must not look like one whose key is simply missing,
    // because "missing" reads as agreement where "unreadable" does not.
    if (!v.readable) {
      out.push({ ...row, observed: undefined, state: "unreadable", reason: v.reason ?? "the document could not be read" });
      continue;
    }

    if (v.observed === undefined) {
      out.push({ ...row, state: "absent", reason: "declared, and the key is not in the document" });
      continue;
    }

    if (sameValue(declared, v.observed)) {
      out.push({ ...row, state: "matches" });
      continue;
    }

    out.push({
      ...row,
      state: "drifted",
      reason: `declared ${JSON.stringify(declared)}, observed ${JSON.stringify(v.observed)}`,
    });
  }
  return out;
}

/**
 * Do a declaration and an observation agree?
 *
 * Compared as text, because the node reads YAML as text while a declaration
 * arrives as JSON: treating `900` and `"900"` as different would report
 * drift on every numeric setting forever, and a drift report that is always
 * wrong is one nobody reads.
 */
function sameValue(declared: unknown, observed: unknown): boolean {
  if (declared === null || declared === undefined || observed === null || observed === undefined) {
    return declared === observed;
  }
  if (typeof declared === "object" || typeof observed === "object") {
    return JSON.stringify(declared) === JSON.stringify(observed);
  }
  return String(declared) === String(observed);
}
