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
import { harnessConfigOptOut } from "../db/schema/harness-config-ops";
import { tenantScope } from "../db/tenant-scope";
import { prefixedId } from "../utils/ids";
import * as broker from "./broker";

/**
 * Ask one station's node for the registry its harness manages — the
 * `config.settings` broker verb, never cached: a registry read is cheap (it
 * touches no disk on the node, see `ConfigSettings()`) and caching it would
 * reintroduce exactly the "true when written" staleness this file exists to
 * avoid. `null` on ANY failure (offline, timeout, disconnected, or a response
 * that isn't the expected shape) — never a thrown error, so every caller
 * here can treat "could not verify" as one outcome rather than a try/catch.
 *
 * Lives here (not in `routes/harness-config.ts`, where it originated) so
 * `services/harness-config-apply.ts` can reuse it without importing a route
 * module — that import would run the other way too (the route imports
 * `planFor`/`applyFor` from the apply service) and form a cycle.
 */
export async function fetchRegistry(nodeId: string, stationKey: string): Promise<ConfigSetting[] | null> {
  const result = await broker.request(nodeId, "config.settings", { stationKey });
  if (!result.ok) return null;
  const settings = (result.data as { settings?: ConfigSetting[] } | undefined)?.settings;
  return Array.isArray(settings) ? settings : null;
}

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

/** Evidence of this system's own write, keyed by `settingId` — Task 7's `applied_harness_config`. */
export interface AppliedWrite {
  /** The gateway pid observed right after the write. `null` when health could not be read at write time. */
  gatewayPid: number | null;
}

/**
 * Compare a station's observed values with what was declared for it.
 *
 * Only settings that were DECLARED are reported: this system has no opinion
 * about a setting nobody mentioned, and reporting one would make the drift
 * list a list of every setting in the fleet.
 *
 * `declared` takes each setting's full `Resolved` — value AND the level it
 * came from — exactly as `resolveFor` returns it. The level is load-bearing:
 * `out-of-scope` fires only when the winning declaration was made at STATION
 * level for a setting whose document is not per-station (`scope !==
 * "profile"`). It is passed through here rather than reduced to a bare value
 * or round-tripped into a side-channel set, because a second structure
 * carrying the same fact is exactly the split that drifts: an optional
 * parameter a caller forgets to populate loses the out-of-scope refusal with
 * no type error — spec §6's protection disappearing silently.
 *
 * `compare()` stays a PURE function of its arguments: `appliedWrites` and
 * `optedOut` are rows the CALLER fetched (from `applied_harness_config` and
 * `harness_config_opt_out`), never a query this function runs itself — the
 * same reason `declared` arrives pre-resolved rather than as a tenant id this
 * function would look up on its own.
 *
 * Precedence, highest first. Written as an ordered list because a state
 * machine whose ordering is implicit is exactly how `opted-out` silently
 * becomes `drifted`:
 *
 *   1. out-of-scope      (the declaration cannot apply to this station at all)
 *   2. unreadable         (the document could not be parsed — never "matches")
 *   3. opted-out          (an explicit operator choice)
 *   4. awaiting-restart   (written, restart needed, gateway pid unchanged)
 *   5. absent / drifted / matches   (the ordinary comparison)
 */
export function compare(args: {
  stationId: string;
  values: ConfigValue[];
  settings: ConfigSetting[];
  declared: Record<string, Resolved>;
  /** Rows from `applied_harness_config`, keyed by `settingId`. Absent (or no
   * entry for a settingId) means "this system never recorded a write" — not
   * the same thing as "no restart is needed". */
  appliedWrites?: Record<string, AppliedWrite>;
  /**
   * The station's CURRENT gateway pid, read from its live health right
   * before `compare()` is called. `null`/`undefined` means the pid could
   * not be confirmed (health degraded, harness stopped) — and per spec F4's
   * asymmetry, an unconfirmed pid must NEVER resolve to `matches`: it stays
   * `awaiting-restart` instead. Claiming a restart is still needed when it
   * isn't costs one needless restart; claiming it isn't needed when it is
   * produces false agreement, the worse of the two.
   */
  currentGatewayPid?: number | null;
  /** `settingId`s an operator explicitly opted out of reconciliation for
   * this station (`harness_config_opt_out`, keyed by station key). */
  optedOut?: Set<string>;
}): ConfigObservation[] {
  const byId = new Map(args.settings.map((s) => [s.id, s]));
  const appliedWrites = args.appliedWrites ?? {};
  const optedOut = args.optedOut ?? new Set<string>();
  const out: ConfigObservation[] = [];

  for (const v of args.values) {
    if (!(v.settingId in args.declared)) continue; // undeclared: no opinion, not reported
    const { value: declared, level } = args.declared[v.settingId]!;
    const setting = byId.get(v.settingId);
    const row = { settingId: v.settingId, stationId: args.stationId, declared, observed: v.observed };

    // 1. out-of-scope: a declaration that cannot be honoured is not drift,
    // and calling it "drifted" would invite an apply that must then refuse.
    if (setting && setting.scope !== "profile" && level === "station") {
      out.push({
        ...row,
        state: "out-of-scope",
        reason: `${v.settingId} is ${setting.scope}-scoped: declaring it for one station would change its siblings on the same host`,
      });
      continue;
    }

    // 2. unreadable: must never collapse into `absent`. A document that
    // could not be read must not look like one whose key is simply missing,
    // because "missing" reads as agreement where "unreadable" does not.
    if (!v.readable) {
      out.push({ ...row, observed: undefined, state: "unreadable", reason: v.reason ?? "the document could not be read" });
      continue;
    }

    // 3. opted-out: an explicit operator choice. It outranks the ordinary
    // comparison so the state names the operator's decision, not whatever
    // the document happens to hold — "drifted" would invite exactly the
    // apply the opt-out exists to prevent.
    if (optedOut.has(v.settingId)) {
      out.push({ ...row, state: "opted-out", reason: "an operator opted this setting out of reconciliation" });
      continue;
    }

    // 4. awaiting-restart: written, the setting needs a restart to take
    // effect, and the gateway pid is either unchanged since the write or
    // could not be confirmed at all. Hermes multiplexes one gateway across
    // every profile, so that pid IS the process that re-reads config — a pid
    // change is the only evidence a restart actually happened.
    if (setting?.restartToTakeEffect) {
      const applied = appliedWrites[v.settingId];
      if (applied) {
        const pidUnavailable = args.currentGatewayPid === null || args.currentGatewayPid === undefined;
        const pidUnchanged = !pidUnavailable && args.currentGatewayPid === applied.gatewayPid;
        if (pidUnavailable || pidUnchanged) {
          out.push({
            ...row,
            state: "awaiting-restart",
            reason: "written, and needs a restart to take effect — the gateway has not restarted since",
          });
          continue;
        }
      }
    }

    // 5. the ordinary comparison.
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
 * Record an operator's explicit choice to exclude one setting from
 * reconciliation on one station — spec D6, ruling R1. Keyed on the STATION
 * KEY (not the row id) so it survives unadopt/re-adopt, matching
 * `harnessConfigOptOut`'s own doc comment.
 *
 * Upserts on `(tenantId, stationKey, settingId)`: opting out twice records
 * the latest reason/author rather than duplicating the row.
 */
export async function optOut(input: {
  stationKey: string;
  settingId: string;
  tenantId: string;
  optedOutBy: string;
  reason?: string;
}): Promise<void> {
  await db
    .insert(harnessConfigOptOut)
    .values({
      id: prefixedId("cfgoo"),
      tenantId: input.tenantId,
      stationKey: input.stationKey,
      settingId: input.settingId,
      reason: input.reason ?? null,
      optedOutBy: input.optedOutBy,
    })
    .onConflictDoUpdate({
      target: [harnessConfigOptOut.tenantId, harnessConfigOptOut.stationKey, harnessConfigOptOut.settingId],
      set: { reason: input.reason ?? null, optedOutBy: input.optedOutBy },
    });
}

/** Remove an opt-out. A setting with no opt-out row is a no-op. */
export async function clearOptOut(input: {
  stationKey: string;
  settingId: string;
  tenantId: string;
}): Promise<void> {
  await db
    .delete(harnessConfigOptOut)
    .where(
      tenantScope(
        harnessConfigOptOut,
        input.tenantId,
        eq(harnessConfigOptOut.stationKey, input.stationKey),
        eq(harnessConfigOptOut.settingId, input.settingId),
      ),
    );
}

/**
 * Every settingId opted out for one station, as a `Set` ready for
 * `compare()`'s `optedOut` argument. The one query shape this file and
 * `services/harness-config-apply.ts`'s `reconcileStation` both need —
 * written once here so a second, drifting copy never gets written inline
 * again.
 */
export async function getOptOuts(tenantId: string, stationKey: string): Promise<Set<string>> {
  const rows = await db
    .select({ settingId: harnessConfigOptOut.settingId })
    .from(harnessConfigOptOut)
    .where(tenantScope(harnessConfigOptOut, tenantId, eq(harnessConfigOptOut.stationKey, stationKey)));
  return new Set(rows.map((r) => r.settingId));
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
