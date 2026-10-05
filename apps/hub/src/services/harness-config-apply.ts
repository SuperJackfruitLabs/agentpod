/**
 * Plan, apply and record a declared harness setting against a station — the
 * hub side of Task 6's broker verbs (`config.plan`, `config.inspect`,
 * `config.apply`), and the journal of what was actually written
 * (`applied_harness_config`).
 *
 * `planFor` and `applyFor` are thin: the node (apps/node-agent) owns deriving
 * a plan, applying it exactly once, and detecting a stale or mismatched
 * digest (see `config_manage.go`'s `PlanConfig`/`ApplyConfig`). This file's
 * job is the hub-side half — resolving an omitted value, checking a setting
 * id against the LIVE registry before the node is asked to plan anything,
 * and recording evidence of a successful apply — never re-deriving what the
 * node already decided.
 *
 * `tenantId` is REQUIRED on every exported function here, never optional —
 * same rule as `services/harness-config.ts`.
 *
 * `reconcileOnAdopt` (Task 8) is the one caller of `planFor`/`applyFor` that
 * is not a route — it runs from `adoptStations`, at the one moment the
 * design calls safe to write a declared setting without racing or fighting
 * the harness (spec §5; see that function's own doc comment). It is written
 * so that **no throw, from any setting on any station, can escape** —
 * adoption must survive it even when a node is offline, refuses a plan or
 * refuses an apply.
 */
import { eq } from "drizzle-orm";
import { ConfigPlan, ConfigReceipt, VERB_RESULTS, type ConfigRefusalCode, type ConfigSetting, type ConfigValue } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { appliedHarnessConfig, harnessConfigOptOut } from "../db/schema/harness-config-ops";
import { stations } from "../db/schema/stations";
import { tenantScope } from "../db/tenant-scope";
import { prefixedId } from "../utils/ids";
import * as broker from "./broker";
import { resolveFor, fetchRegistry, compare, type Resolved } from "./harness-config";
import type { StationRow } from "./station-registry";

/** A minimal station shape — everything `planFor`/`applyFor` need to reach a node. */
export type ConfigStation = Pick<StationRow, "id" | "nodeId" | "stationKey">;

/**
 * Thrown by `planFor`/`applyFor` for any refusal the ROUTE must turn into a
 * status code. `code` is a `ConfigRefusalCode` when the refusal is one the
 * contract names, and `"NODE_UNREACHABLE"` when the node itself could not be
 * asked — distinct, because the remedy differs: re-check the setting id and
 * declaration for the first, retry once the node is back for the second.
 */
export class ConfigApplyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: ConfigRefusalCode | "NODE_UNREACHABLE",
  ) {
    super(message);
    this.name = "ConfigApplyError";
  }
}

/**
 * Plan an edit for `settings` on one station.
 *
 * 1. Reads the LIVE registry from the station's own node — never a cached
 *    copy — and refuses any requested id it does not carry, by name, before
 *    `config.plan` is ever dispatched. A `null` registry (offline node,
 *    timeout, bad response) is NOT the same thing as "no ids match": it
 *    means nothing could be verified, so the whole plan is refused as
 *    unreachable (502) rather than silently answered with an empty plan.
 * 2. Resolves any omitted `value` from what is declared for this station —
 *    its own declaration, else its node's, else the fleet's (`resolveFor`).
 *    A setting with nothing declared and no value given is refused: an
 *    omitted value is a request to plan against "whatever the fleet
 *    wants", and there is nothing to plan against when nobody has said.
 * 3. Mints this operation's id and asks the node to derive the plan.
 */
export async function planFor(args: {
  tenantId: string;
  station: ConfigStation;
  settings: Array<{ settingId: string; value?: unknown }>;
}): Promise<ConfigPlan> {
  const registry = await fetchRegistry(args.station.nodeId, args.station.stationKey);
  if (registry === null) {
    throw new ConfigApplyError(
      502,
      "the node could not be reached to confirm its setting registry",
      "NODE_UNREACHABLE",
    );
  }
  const byId = new Map(registry.map((s) => [s.id, s]));

  let declared: Record<string, Resolved> | null = null;
  const want: Array<{ settingId: string; value: unknown }> = [];
  for (const s of args.settings) {
    if (!byId.has(s.settingId)) {
      throw new ConfigApplyError(
        400,
        `${s.settingId} is not a setting this station's harness manages`,
        "UNKNOWN_SETTING",
      );
    }

    let value = s.value;
    if (value === undefined) {
      declared ??= await resolveFor(args.station.id, args.station.nodeId, args.tenantId);
      const resolved = declared[s.settingId];
      if (!resolved) {
        throw new ConfigApplyError(
          400,
          `no value was given for ${s.settingId} and nothing is declared for this station to resolve it from`,
          "UNKNOWN_SETTING",
        );
      }
      value = resolved.value;
    }
    want.push({ settingId: s.settingId, value });
  }

  const operationId = prefixedId("cfgop");
  const result = await broker.request(args.station.nodeId, "config.plan", {
    stationKey: args.station.stationKey,
    operationId,
    want,
  });
  if (!result.ok) {
    throw new ConfigApplyError(502, result.error ?? "the node could not be reached", "NODE_UNREACHABLE");
  }

  const parsed = ConfigPlan.safeParse(result.data);
  if (!parsed.success) {
    throw new ConfigApplyError(502, "the node returned an unexpected plan", "NODE_UNREACHABLE");
  }
  return parsed.data;
}

/**
 * Apply the plan previously reviewed as `planDigest` for `operationId`.
 *
 * Forwards to the node's `config.apply` unchanged — the node is the one that
 * re-derives, checks the digest against its own journal, and decides
 * `applied` vs `conflict` (never an error for a digest mismatch; see
 * `hermes_config.go`'s `ApplyConfig`). This function adds exactly one thing
 * the node cannot: once the node reports `applied`, it reads this station's
 * CURRENT health for the gateway pid/uptime and records one
 * `applied_harness_config` row per setting the node actually wrote — the
 * restart evidence a later task's `awaiting-restart` state needs.
 */
export async function applyFor(args: {
  tenantId: string;
  station: ConfigStation;
  operationId: string;
  planDigest: string;
}): Promise<ConfigReceipt> {
  const result = await broker.request(args.station.nodeId, "config.apply", {
    stationKey: args.station.stationKey,
    operationId: args.operationId,
    planDigest: args.planDigest,
  });
  if (!result.ok) {
    throw new ConfigApplyError(502, result.error ?? "the node could not be reached", "NODE_UNREACHABLE");
  }

  const parsed = ConfigReceipt.safeParse(result.data);
  if (!parsed.success) {
    throw new ConfigApplyError(502, "the node returned an unexpected receipt", "NODE_UNREACHABLE");
  }
  const receipt = parsed.data;

  if (receipt.phase === "applied" && receipt.written.length > 0) {
    const health = await broker.request(args.station.nodeId, "health", {
      key: args.station.stationKey,
    });
    const healthParsed = health.ok ? VERB_RESULTS.health.safeParse(health.data) : undefined;
    const gatewayPid = healthParsed?.success ? healthParsed.data.pid : null;
    const gatewayUptimeSec = healthParsed?.success ? healthParsed.data.uptimeSec : null;
    const appliedAt = new Date();

    for (const written of receipt.written) {
      await recordApplied({
        tenantId: args.tenantId,
        stationId: args.station.id,
        settingId: written.settingId,
        value: written.wrote,
        gatewayPid,
        gatewayUptimeSec,
        appliedAt,
      });
    }
  }

  return receipt;
}

/**
 * Record one setting as actually written to a station, under the gateway pid
 * observed right after the apply — the evidence `awaiting-restart` needs
 * later: Hermes multiplexes one gateway across profiles, so that pid IS the
 * process that re-reads config.
 *
 * Upserts on `(tenantId, stationId, settingId)` — a plain unique constraint
 * is correct here (no nullable column in the key, unlike the fleet level of
 * `declared_harness_config`), so a second apply of the same setting replaces
 * the row rather than duplicating it.
 */
export async function recordApplied(args: {
  tenantId: string;
  stationId: string;
  settingId: string;
  value: unknown;
  gatewayPid: number | null;
  gatewayUptimeSec: number | null;
  appliedAt: Date;
}): Promise<void> {
  await db
    .insert(appliedHarnessConfig)
    .values({
      id: prefixedId("acfg"),
      tenantId: args.tenantId,
      stationId: args.stationId,
      settingId: args.settingId,
      value: args.value,
      gatewayPid: args.gatewayPid,
      gatewayUptimeSec: args.gatewayUptimeSec,
      appliedAt: args.appliedAt,
    })
    .onConflictDoUpdate({
      target: [appliedHarnessConfig.tenantId, appliedHarnessConfig.stationId, appliedHarnessConfig.settingId],
      set: {
        value: args.value,
        gatewayPid: args.gatewayPid,
        gatewayUptimeSec: args.gatewayUptimeSec,
        appliedAt: args.appliedAt,
      },
    });
}

/** The applied row for one (station, setting) in this tenant, if any. */
export async function getAppliedConfig(
  tenantId: string,
  stationId: string,
  settingId: string,
): Promise<typeof appliedHarnessConfig.$inferSelect | null> {
  const rows = await db
    .select()
    .from(appliedHarnessConfig)
    .where(
      tenantScope(
        appliedHarnessConfig,
        tenantId,
        eq(appliedHarnessConfig.stationId, stationId),
        eq(appliedHarnessConfig.settingId, settingId),
      ),
    );
  return rows[0] ?? null;
}

// ─── reconcileOnAdopt ──────────────────────────────────────────────────────────

/** What `reconcileOnAdopt` did with one declared setting on one station. */
export interface ReconcileOutcome {
  stationId: string;
  settingId: string;
  result: "applied" | "skipped" | "failed";
  reason?: string;
}

/**
 * Reconcile every declared harness setting onto a batch of just-adopted
 * stations — called from `adoptStations` (`station-registry.ts`) AFTER its
 * rows are written, because a plan needs each station's real, persisted
 * `id` (the one the upsert's `ON CONFLICT` may have kept from a prior
 * adoption, not a value minted for this call and discarded).
 *
 * Per station, per declared setting: skip `report-only` (never written by
 * this system, spec D2), skip an explicit opt-out (`harness_config_opt_out`,
 * keyed by station key so it survives unadopt/re-adopt — ruling R1), skip
 * one that already matches (no write, no receipt). Otherwise plan, then
 * apply with the plan's own digest.
 *
 * **Every station is isolated.** One station's failure — offline node, a
 * plan refusal, an apply refusal, an unreadable document — is recorded
 * against THAT station (`stations.configReason`) and never thrown: the
 * design's own words are "a station adopted with one setting unwritten is
 * better than one not adopted." The per-station try/catch here is the outer
 * guarantee; `reconcileStation` is written to catch its own failures too,
 * so a bug in either layer still cannot surface as a thrown adoption.
 *
 * This runs exactly once, at adopt time. It is not a sweep and must never be
 * called from a timer: the harness rewrites its own config file and
 * persists operator decisions into that same file, so a reconciler running
 * on a tick would race the harness or silently undo what an operator just
 * changed through it (spec F1, design rejecting continuous reconciliation).
 */
export async function reconcileOnAdopt(
  tenantId: string,
  adoptedStations: ConfigStation[],
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  for (const station of adoptedStations) {
    try {
      outcomes.push(...(await reconcileStation(tenantId, station)));
    } catch (err) {
      // `reconcileStation` is written to swallow every failure itself; this
      // catch is defense in depth only, so a bug in the line above can never
      // undo an adoption whose rows are already committed.
      const reason = err instanceof Error ? err.message : String(err);
      outcomes.push({ stationId: station.id, settingId: "*", result: "failed", reason });
      await setConfigReason(station.id, reason);
    }
  }
  return outcomes;
}

/**
 * Reconcile one station. Never throws — every awaited call below that can
 * fail (a broker round trip, `planFor`, `applyFor`) is inside its own
 * try/catch, and the function's own failure-recording write
 * (`setConfigReason`) swallows its own errors too, so a Postgres hiccup
 * while recording a reason cannot turn into a second, unrelated failure.
 */
async function reconcileStation(tenantId: string, station: ConfigStation): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  const failureReasons: string[] = [];

  const declared = await resolveFor(station.id, station.nodeId, tenantId);
  const settingIds = Object.keys(declared);
  if (settingIds.length === 0) {
    await setConfigReason(station.id, null);
    return outcomes;
  }

  const registry = await fetchRegistry(station.nodeId, station.stationKey);
  if (registry === null) {
    // Offline, timeout, disconnected — nothing could be verified, so nothing
    // is attempted. Matches `planFor`'s own NODE_UNREACHABLE treatment of a
    // null registry: "could not verify" is not "nothing to do".
    const reason = "the node could not be reached to confirm its setting registry";
    for (const settingId of settingIds) {
      outcomes.push({ stationId: station.id, settingId, result: "failed", reason });
    }
    await setConfigReason(station.id, reason);
    return outcomes;
  }
  const registryById = new Map(registry.map((s) => [s.id, s]));

  const optOutRows = await db
    .select({ settingId: harnessConfigOptOut.settingId })
    .from(harnessConfigOptOut)
    .where(tenantScope(harnessConfigOptOut, tenantId, eq(harnessConfigOptOut.stationKey, station.stationKey)));
  const optedOut = new Set(optOutRows.map((r) => r.settingId));

  const candidateIds: string[] = [];
  for (const settingId of settingIds) {
    const setting = registryById.get(settingId);
    if (!setting) continue; // not a setting this station's CURRENT harness manages; nothing to reconcile
    if (setting.policy === "report-only") {
      outcomes.push({ stationId: station.id, settingId, result: "skipped", reason: "report-only: never written by this system" });
      continue;
    }
    if (optedOut.has(settingId)) {
      outcomes.push({ stationId: station.id, settingId, result: "skipped", reason: "opted out" });
      continue;
    }
    candidateIds.push(settingId);
  }

  if (candidateIds.length > 0) {
    const observeResult = await broker.request(station.nodeId, "config.observe", {
      stationKey: station.stationKey,
      settings: candidateIds,
    });
    const rawValues = observeResult.ok
      ? ((observeResult.data as { values?: ConfigValue[] } | undefined)?.values ?? [])
      : [];
    const observeFailureReason = observeResult.ok
      ? "the node did not return a value for every requested setting"
      : (observeResult.error ?? "the node could not be reached");
    const valuesById = new Map(rawValues.map((v) => [v.settingId, v]));
    // Every candidate gets a ConfigValue before `compare()` ever sees it —
    // the same guarantee `routes/harness-config.ts`'s `observeStation` keeps,
    // for the same reason: a short list must never read as agreement.
    const values: ConfigValue[] = candidateIds.map(
      (id) => valuesById.get(id) ?? { settingId: id, readable: false, reason: observeFailureReason },
    );
    const settingsForCompare = candidateIds
      .map((id) => registryById.get(id))
      .filter((s): s is ConfigSetting => s !== undefined);

    const observations = compare({ stationId: station.id, declared, values, settings: settingsForCompare });

    for (const obs of observations) {
      if (obs.state === "matches") {
        outcomes.push({ stationId: station.id, settingId: obs.settingId, result: "skipped", reason: "already matches" });
        continue;
      }
      if (obs.state === "out-of-scope") {
        // Declared per-station for a setting that is not per-station — not
        // honourable by an apply, and not a failure either (D7).
        outcomes.push({ stationId: station.id, settingId: obs.settingId, result: "skipped", reason: obs.reason });
        continue;
      }
      if (obs.state === "unreadable") {
        const reason = obs.reason ?? "the document could not be read";
        outcomes.push({ stationId: station.id, settingId: obs.settingId, result: "failed", reason });
        failureReasons.push(`${obs.settingId}: ${reason}`);
        continue;
      }

      // "drifted" or "absent": plan, then apply with the plan's own digest.
      try {
        const plan = await planFor({ tenantId, station, settings: [{ settingId: obs.settingId }] });
        if (plan.noOp) {
          outcomes.push({ stationId: station.id, settingId: obs.settingId, result: "skipped", reason: "plan is a no-op" });
          continue;
        }
        const receipt = await applyFor({
          tenantId,
          station,
          operationId: plan.operationId,
          planDigest: plan.planDigest,
        });
        if (receipt.phase === "applied") {
          outcomes.push({ stationId: station.id, settingId: obs.settingId, result: "applied" });
        } else {
          const reason = receipt.error ?? `the node reported "${receipt.phase}" instead of applying it`;
          outcomes.push({ stationId: station.id, settingId: obs.settingId, result: "failed", reason });
          failureReasons.push(`${obs.settingId}: ${reason}`);
        }
      } catch (err) {
        // Covers `ConfigApplyError` (a refusal, or the node unreachable
        // between plan and apply) and anything else planFor/applyFor could
        // throw — this station's turn ends here, the next setting or the
        // next station is unaffected.
        const reason = err instanceof Error ? err.message : String(err);
        outcomes.push({ stationId: station.id, settingId: obs.settingId, result: "failed", reason });
        failureReasons.push(`${obs.settingId}: ${reason}`);
      }
    }
  }

  await setConfigReason(station.id, failureReasons.length > 0 ? failureReasons.join("; ") : null);
  return outcomes;
}

/**
 * Record why reconciliation could not finish for a station — the same shape
 * as `provisionedRuntimes.statusReason` (`services/runtimes.ts`): free text,
 * null when there is nothing to explain. Swallows its own failure: a
 * Postgres hiccup while recording a reason must not become a second,
 * unrelated throw on top of the one it was trying to record.
 */
async function setConfigReason(stationId: string, reason: string | null): Promise<void> {
  try {
    await db.update(stations).set({ configReason: reason }).where(eq(stations.id, stationId));
  } catch {
    // Recording a reconcile failure must never itself fail the adoption.
  }
}
