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
import { eq, isNull, or, SQL } from "drizzle-orm";
import type { ConfigObservation, ConfigSetting, ConfigValue } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { declaredHarnessConfig } from "../db/schema/harness-config";
import { harnessConfigOptOut, type HarnessConfigOptOutRow } from "../db/schema/harness-config-ops";
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
 * no type error — spec §6's protection disappearing silently. The same
 * `level` is also what each produced `ConfigObservation.level` carries
 * (Phase 3), so the console reads the resolution level that won rather than
 * re-deriving station → node → fleet precedence a second time, client-side.
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
 *   3. opted-out          (an explicit operator choice — the hub's own
 *                          register, or the harness's own record, D11)
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
   * the same thing as "no restart is needed". A row whose `gatewayPid` is
   * `null` is a write whose own health read failed: no evidence of a restart
   * on the recorded side, treated exactly as an unconfirmable current pid. */
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
    const row = { settingId: v.settingId, stationId: args.stationId, declared, observed: v.observed, level };

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

    // 3. opted-out: an explicit operator choice, from either of two sources.
    // It outranks the ordinary comparison so the state names the operator's
    // decision, not whatever the document happens to hold — "drifted" would
    // invite exactly the apply the opt-out exists to prevent. The two
    // sources are kept distinguishable in the REASON text (D11): the hub's
    // own register is agentpod's doing and is visible in this system without
    // ever looking at the document; the harness's own record
    // (`ConfigValue.optedOutByHarness` — Hermes' `plugins.disabled`) is the
    // operator speaking through the harness's own UI, invisible until
    // someone reads the file. Both refuse a write; only the wording tells
    // an operator which one fired.
    if (optedOut.has(v.settingId)) {
      out.push({ ...row, state: "opted-out", reason: "an operator opted this setting out of reconciliation" });
      continue;
    }
    if (v.optedOutByHarness) {
      out.push({
        ...row,
        state: "opted-out",
        reason: `${setting?.harness ?? "the harness"} itself reports this setting disabled (its own plugins.disabled) — not an agentpod exemption`,
      });
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
        // Unconfirmable on EITHER side. A null `currentGatewayPid` is health
        // failing now; a null `applied.gatewayPid` is health having failed at
        // write time (`applyFor` records null whenever the post-write `health`
        // round trip times out or does not parse). Both mean the same thing —
        // no evidence any restart happened — and the asymmetry spec F4 names
        // runs in both directions: comparing `4242 === null` as an ordinary
        // pid change would fall through to `matches` and report a file saying
        // 900 with a gateway still enforcing 300 as agreement.
        const pidUnavailable = args.currentGatewayPid == null || applied.gatewayPid == null;
        const pidUnchanged = !pidUnavailable && args.currentGatewayPid === applied.gatewayPid;
        if (pidUnavailable || pidUnchanged) {
          out.push({
            ...row,
            state: "awaiting-restart",
            reason: pidUnavailable
              ? "written, and needs a restart to take effect — the gateway pid could not be confirmed, so no restart can be shown to have happened"
              : "written, and needs a restart to take effect — the gateway has not restarted since",
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

/** A level an exemption can target: a station (by its stable key) or a node. */
export type OptOutLevel = "station" | "node";

/**
 * Exactly one of `stationKey` / `nodeId` must be set — mirrors
 * `cfg_opt_out_one_level`, the table's own CHECK constraint. Checked here,
 * like `assertOneLevel` above, because no index can express "caught before
 * the write" as cleanly as a thrown error.
 */
function assertOneOptOutLevel(input: { stationKey?: string; nodeId?: string }): void {
  const hasStation = input.stationKey !== undefined;
  const hasNode = input.nodeId !== undefined;
  if (hasStation === hasNode) {
    throw new Error("an opt-out targets exactly one level: a station or a node");
  }
}

/** The predicate that identifies the single row for one (tenant, setting, level). */
function optOutLevelWhere(input: {
  settingId: string;
  tenantId: string;
  stationKey?: string;
  nodeId?: string;
}): SQL {
  return tenantScope(
    harnessConfigOptOut,
    input.tenantId,
    eq(harnessConfigOptOut.settingId, input.settingId),
    input.stationKey !== undefined
      ? eq(harnessConfigOptOut.stationKey, input.stationKey)
      : isNull(harnessConfigOptOut.stationKey),
    input.nodeId !== undefined
      ? eq(harnessConfigOptOut.nodeId, input.nodeId)
      : isNull(harnessConfigOptOut.nodeId),
  );
}

/**
 * Record (or update) an operator's explicit exemption at one level — a
 * station, keyed on its STABLE KEY (not the row id) so it survives
 * unadopt/re-adopt, or a node, exempting every station on it. Exactly one
 * of `stationKey`/`nodeId` is given, matching `cfg_opt_out_one_level`.
 *
 * `optedOut` is carried explicitly rather than implied by the row's mere
 * existence: a `false` station row is how a station opts BACK IN against a
 * node-wide exemption — see `resolveOptOuts`, and the schema's own doc
 * comment, and plan ruling R1.
 *
 * Delete-then-insert inside one transaction — the same idiom `declare()`
 * uses above, and for the identical reason: Postgres never treats a NULL
 * `stationKey`/`nodeId` as a conflict against another NULL, so an
 * `ON CONFLICT` upsert needs a separate `target`/`targetWhere` per level (it
 * had exactly one, for the station level only, before this — the partial-
 * index trap this file now avoids by using one idiom for both tables rather
 * than fixing the upsert twice).
 */
export async function setOptOut(input: {
  tenantId: string;
  settingId: string;
  optedOut: boolean;
  stationKey?: string;
  nodeId?: string;
  reason?: string;
  optedOutBy: string;
}): Promise<void> {
  assertOneOptOutLevel(input);
  await db.transaction(async (tx) => {
    await tx.delete(harnessConfigOptOut).where(optOutLevelWhere(input));
    await tx.insert(harnessConfigOptOut).values({
      id: prefixedId("cfgoo"),
      tenantId: input.tenantId,
      stationKey: input.stationKey ?? null,
      nodeId: input.nodeId ?? null,
      settingId: input.settingId,
      optedOut: input.optedOut,
      reason: input.reason ?? null,
      optedOutBy: input.optedOutBy,
    });
  });
}

/**
 * Remove an exemption at one level. A level with no row is a no-op —
 * `cleared: false` tells the caller nothing was there to clear, as distinct
 * from "cleared it".
 */
export async function clearOptOut(input: {
  tenantId: string;
  settingId: string;
  stationKey?: string;
  nodeId?: string;
}): Promise<{ cleared: boolean }> {
  assertOneOptOutLevel(input);
  const deleted = await db
    .delete(harnessConfigOptOut)
    .where(optOutLevelWhere(input))
    .returning({ id: harnessConfigOptOut.id });
  return { cleared: deleted.length > 0 };
}

/**
 * settingIds this station is exempt from, as a `Set` ready for `compare()`'s
 * `optedOut` argument — resolved most-specific-first, exactly as
 * declarations resolve (`resolveFor`): a STATION row decides outright when
 * present, true or false, and only its ABSENCE falls through to the node
 * row; a node row with no station row decides; neither row means not
 * exempt.
 *
 * The station/false case is the whole point (plan ruling R1): collapsing
 * "absent" and "false" would make a station unable to opt back in against a
 * node-wide exemption, which is the entire reason `optedOut` is a boolean
 * column rather than mere row existence.
 *
 * Reads both levels in one query and resolves in code — never two
 * round trips a caller could observe half of.
 */
export async function resolveOptOuts(
  tenantId: string,
  stationKey: string,
  nodeId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      settingId: harnessConfigOptOut.settingId,
      stationKey: harnessConfigOptOut.stationKey,
      nodeId: harnessConfigOptOut.nodeId,
      optedOut: harnessConfigOptOut.optedOut,
    })
    .from(harnessConfigOptOut)
    .where(
      tenantScope(
        harnessConfigOptOut,
        tenantId,
        or(eq(harnessConfigOptOut.stationKey, stationKey), eq(harnessConfigOptOut.nodeId, nodeId))!,
      ),
    );

  const station = new Map<string, boolean>();
  const node = new Map<string, boolean>();
  for (const r of rows) {
    if (r.stationKey === stationKey) station.set(r.settingId, r.optedOut);
    else if (r.nodeId === nodeId) node.set(r.settingId, r.optedOut);
  }

  const out = new Set<string>();
  const settingIds = new Set<string>([...station.keys(), ...node.keys()]);
  for (const settingId of settingIds) {
    const stationDecision = station.get(settingId);
    if (stationDecision !== undefined) {
      // A station row decides outright, true or false — it never falls
      // through to the node row.
      if (stationDecision) out.add(settingId);
      continue;
    }
    if (node.get(settingId)) out.add(settingId);
  }
  return out;
}

/** Every opt-out row, optionally narrowed to one station or one node — the register, unresolved. */
export async function listOptOuts(
  tenantId: string,
  filter?: { stationKey?: string; nodeId?: string },
): Promise<HarnessConfigOptOutRow[]> {
  return db
    .select()
    .from(harnessConfigOptOut)
    .where(
      tenantScope(
        harnessConfigOptOut,
        tenantId,
        filter?.stationKey !== undefined ? eq(harnessConfigOptOut.stationKey, filter.stationKey) : undefined,
        filter?.nodeId !== undefined ? eq(harnessConfigOptOut.nodeId, filter.nodeId) : undefined,
      ),
    );
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
