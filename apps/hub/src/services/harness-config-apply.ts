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
 */
import { eq } from "drizzle-orm";
import { ConfigPlan, ConfigReceipt, VERB_RESULTS, type ConfigRefusalCode } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { appliedHarnessConfig } from "../db/schema/harness-config-ops";
import { tenantScope } from "../db/tenant-scope";
import { prefixedId } from "../utils/ids";
import * as broker from "./broker";
import { resolveFor, fetchRegistry, type Resolved } from "./harness-config";
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
