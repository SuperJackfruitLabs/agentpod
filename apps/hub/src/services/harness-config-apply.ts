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
import { appliedHarnessConfig } from "../db/schema/harness-config-ops";
import { stations } from "../db/schema/stations";
import { tenantScope } from "../db/tenant-scope";
import { prefixedId } from "../utils/ids";
import * as broker from "./broker";
import { resolveFor, fetchRegistry, compare, getOptOuts, type Resolved, type AppliedWrite } from "./harness-config";
import type { StationRow } from "./station-registry";

/** A minimal station shape — everything `planFor`/`applyFor` need to reach a node. */
export type ConfigStation = Pick<StationRow, "id" | "nodeId" | "stationKey">;

/**
 * Thrown by `planFor`/`applyFor` for any refusal the ROUTE must turn into a
 * status code. `code` is a `ConfigRefusalCode` when the refusal is one the
 * contract names — including one the NODE named, carried through verbatim —
 * and one of two hub-side codes otherwise, each distinct because the remedy
 * is: `"NODE_UNREACHABLE"` (the node could not be asked at all; retry once it
 * is back) and `"NOTHING_DECLARED"` (the setting is real and manageable, but
 * nobody has said what the fleet wants it to be; run `fleet config set`).
 *
 * `NOTHING_DECLARED` is deliberately NOT in the contract's
 * `ConfigRefusalCode`: that enum is the set of refusals a NODE can produce,
 * and no node can produce this one — only the hub knows what is declared.
 * `NODE_UNREACHABLE` is outside it for the same reason.
 */
export class ConfigApplyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: ConfigRefusalCode | "NODE_UNREACHABLE" | "NOTHING_DECLARED",
  ) {
    super(message);
    this.name = "ConfigApplyError";
  }
}

/**
 * The HTTP status a refusal the NODE named answers with (finding 3).
 *
 * Split by whether RE-SENDING THE SAME REQUEST could ever work:
 *
 *   - **400** — it could not. The request names something that cannot be
 *     planned as written, and nothing that happens on the station will change
 *     that: an unregistered id, a level with no document, a value that does
 *     not fit the setting's shape, a setting an operator has opted out, a
 *     target that is a credential file. The remedy is a different request
 *     (usually `fleet config set`) or a different declaration.
 *   - **409** — it could. The request is well-formed and would have been
 *     honoured; it lost to the state of the document or the station between
 *     being made and being answered. The remedy is to re-read and re-send:
 *     re-plan (`PLAN_STALE`), re-read the plan that was reviewed
 *     (`PLAN_DIGEST_MISMATCH`), or wait for a document that can be parsed
 *     (`UNREADABLE`).
 *
 * This is the earlier rule ("about what was asked for" vs "about the state of
 * the document or the station") restated so that it decides the two codes it
 * previously got wrong. `SHAPE_UNEXPECTED` was 409 although its commonest
 * cause — and the one the docs cite — is a declared value that does not fit
 * the setting, which is the caller's to fix and never resolves itself; its
 * other cause, a derived edit that would disturb the document, equally never
 * succeeds on a retry of the same request. `OPTED_OUT` was 400 when the hub
 * noticed and 409 when the node did, which made one code two statuses
 * depending on who got there first.
 *
 * Exhaustive on purpose: a refusal code added to the contract without a
 * status decided here is a type error, not a silent 409.
 *
 * Either way the node's own code and sentence travel to the caller unchanged
 * — a refused plan must never be reported as a plan, and must never be recast
 * as "the node could not be reached", which is what happened before: the node
 * answered promptly and named the problem, and the hub sent the operator to
 * debug connectivity that was fine.
 */
export function statusForRefusal(code: ConfigRefusalCode): 400 | 409 {
  switch (code) {
    case "UNKNOWN_SETTING":
    case "OUT_OF_SCOPE":
    case "SHAPE_UNEXPECTED":
    case "OPTED_OUT":
    case "CREDENTIAL_PATH":
      return 400;
    case "PLAN_STALE":
    case "PLAN_DIGEST_MISMATCH":
    case "UNREADABLE":
      return 409;
    default: {
      // Unreachable while the switch covers `ConfigRefusalCode`; this line
      // stops compiling if a code is added without a status.
      const unhandled: never = code;
      void unhandled;
      return 409;
    }
  }
}

/** One setting `planFor` refused to include in the plan it sent to the node. */
export interface PlanRefusal {
  settingId: string;
  code: "OPTED_OUT";
  message: string;
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
 * 2. Checks each requested id against the opt-out register
 *    (`harness_config_opt_out`, spec D6). An explicit operator opt-out wins:
 *    an opted-out id is excluded from `want` — never sent to the node to
 *    plan — and reported back in `refused`, named, with `OPTED_OUT`. This is
 *    a PER-SETTING refusal, not a whole-request one: `fleet config plan
 *    --station ID` plans every setting currently declared for a station
 *    with no way to narrow it, so refusing the entire request over one
 *    opted-out setting would let that one opt-out block writing anything
 *    else to the station. Only when EVERY requested setting is opted out —
 *    leaving nothing to plan — does this throw instead of returning a plan.
 * 3. Resolves any omitted `value` from what is declared for this station —
 *    its own declaration, else its node's, else the fleet's (`resolveFor`).
 *    A setting with nothing declared and no value given is refused with
 *    `NOTHING_DECLARED`: an omitted value is a request to plan against
 *    "whatever the fleet wants", and there is nothing to plan against when
 *    nobody has said.
 * 4. Mints this operation's id and asks the node to derive the plan.
 * 5. A plan the node REFUSED is thrown, never returned: the node's own
 *    refusal code and sentence reach the caller, with a status that tells a
 *    programmatic caller it is not a plan.
 */
export async function planFor(args: {
  tenantId: string;
  station: ConfigStation;
  settings: Array<{ settingId: string; value?: unknown }>;
}): Promise<{ plan: ConfigPlan; refused: PlanRefusal[] }> {
  const registry = await fetchRegistry(args.station.nodeId, args.station.stationKey);
  if (registry === null) {
    throw new ConfigApplyError(
      502,
      "the node could not be reached to confirm its setting registry",
      "NODE_UNREACHABLE",
    );
  }
  const byId = new Map(registry.map((s) => [s.id, s]));
  const optedOut = await getOptOuts(args.tenantId, args.station.stationKey);

  let declared: Record<string, Resolved> | null = null;
  const want: Array<{ settingId: string; value: unknown }> = [];
  const refused: PlanRefusal[] = [];
  for (const s of args.settings) {
    if (!byId.has(s.settingId)) {
      throw new ConfigApplyError(
        400,
        `${s.settingId} is not a setting this station's harness manages`,
        "UNKNOWN_SETTING",
      );
    }

    if (optedOut.has(s.settingId)) {
      refused.push({
        settingId: s.settingId,
        code: "OPTED_OUT",
        message: `an operator opted ${s.settingId} out of reconciliation for this station; it will not be planned or written`,
      });
      continue;
    }

    let value = s.value;
    if (value === undefined) {
      declared ??= await resolveFor(args.station.id, args.station.nodeId, args.tenantId);
      const resolved = declared[s.settingId];
      if (!resolved) {
        // NOT `UNKNOWN_SETTING` (finding 5): that code means "an id not in
        // the registry" (D1), and `byId.has` just proved this id IS in the
        // live registry. The remedies are different sentences — declare a
        // value here, check the id there — so they are different codes.
        throw new ConfigApplyError(
          400,
          `nothing is declared for ${s.settingId} on this station, at station, node or fleet level, and no value was given to plan against`,
          "NOTHING_DECLARED",
        );
      }
      value = resolved.value;
    }
    want.push({ settingId: s.settingId, value });
  }

  if (want.length === 0) {
    // Every requested setting was opted out — there is nothing left to plan.
    // Refused wholly, because an empty `want` is not a request the node can
    // answer, not because the opt-out deserves a different treatment than
    // the per-setting refusal above.
    const names = refused.map((r) => r.settingId).join(", ");
    throw new ConfigApplyError(
      400,
      `an operator opted ${names} out of reconciliation for this station; nothing left to plan`,
      "OPTED_OUT",
    );
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
  // 5. A REFUSED plan is not a plan (finding 3). The node carries `refusal`
  // with a populated digest and `noOp: false`, and deliberately does not
  // journal it — so handing it back as a 200 let `fleet config plan` exit 0
  // on a refusal, and let `reconcileStation` go straight on to `applyFor`,
  // where the node answered `ErrConfigOperationNotFound` and the hub recorded
  // "the node could not be reached" against the station. The node's own code
  // and sentence are what the caller gets instead.
  if (parsed.data.refusal) {
    const { code, message } = parsed.data.refusal;
    throw new ConfigApplyError(statusForRefusal(code), message, code);
  }
  return { plan: parsed.data, refused };
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
 *
 * Before any of that, it re-checks the opt-out register — never trusting
 * `planFor` alone. An operator can opt a station out of a setting AFTER a
 * plan naming it was reviewed and BEFORE it is applied; that window is
 * exactly where the opt-out matters most, because nothing stops a plan from
 * sitting reviewed for any length of time. The settings a plan actually
 * covers are read from the node's own journal (`config.inspect`) rather
 * than trusted from the caller — the same "never re-derive what the node
 * already decided" posture as the rest of this file, applied to "what does
 * this operation cover" instead of "what should be written". Any requested
 * operation naming a setting now opted out is refused WHOLLY: `config.apply`
 * applies one journaled plan as a single atomic write, so there is no way to
 * write "everything in this plan except the opted-out entry" — the plan has
 * already been narrowed once, at `planFor` time, to exclude anything opted
 * out BEFORE it was created. A race landing here means the opt-out arrived
 * after that narrowing, and the whole apply must wait for a fresh plan.
 *
 * The register is read first and the (more expensive) node round trip for
 * `config.inspect` only made when it is non-empty — a station nobody has
 * ever opted anything out on pays nothing extra on its apply path.
 */
export async function applyFor(args: {
  tenantId: string;
  station: ConfigStation;
  operationId: string;
  planDigest: string;
}): Promise<ConfigReceipt> {
  const optedOut = await getOptOuts(args.tenantId, args.station.stationKey);
  if (optedOut.size > 0) {
    const inspect = await broker.request(args.station.nodeId, "config.inspect", {
      stationKey: args.station.stationKey,
      operationId: args.operationId,
    });
    if (!inspect.ok) {
      throw new ConfigApplyError(502, inspect.error ?? "the node could not be reached", "NODE_UNREACHABLE");
    }
    const parsedInspect = ConfigReceipt.safeParse(inspect.data);
    if (!parsedInspect.success) {
      throw new ConfigApplyError(502, "the node returned an unexpected receipt", "NODE_UNREACHABLE");
    }
    const blocked = parsedInspect.data.plan.entries
      .map((entry) => entry.settingId)
      .filter((settingId) => optedOut.has(settingId));
    if (blocked.length > 0) {
      throw new ConfigApplyError(
        400,
        `an operator opted ${blocked.join(", ")} out of reconciliation for this station after this plan was made; refusing to write ${blocked.length === 1 ? "it" : "them"}`,
        "OPTED_OUT",
      );
    }
  }

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

/**
 * Every `applied_harness_config` row for one station, keyed by settingId —
 * shaped exactly for `compare()`'s `appliedWrites` argument (Task 9b). A
 * setting this system never wrote is simply absent from the map: `compare()`
 * already treats "no entry" as "this system never recorded a write", not as
 * "no restart needed".
 */
export async function getAppliedWrites(
  tenantId: string,
  stationId: string,
): Promise<Record<string, AppliedWrite>> {
  const rows = await db
    .select()
    .from(appliedHarnessConfig)
    .where(tenantScope(appliedHarnessConfig, tenantId, eq(appliedHarnessConfig.stationId, stationId)));
  const out: Record<string, AppliedWrite> = {};
  for (const r of rows) out[r.settingId] = { gatewayPid: r.gatewayPid };
  return out;
}

/**
 * Read a station's CURRENT gateway pid from its live health — the same
 * request/parse shape `applyFor` uses right after a write (`health` verb →
 * `VERB_RESULTS.health` → `.pid`), but on demand for any caller that needs
 * `compare()`'s `currentGatewayPid` (Task 9b). Never throws: a failed or
 * unanswered request (offline node, timeout, disconnected, or a response
 * that is not the expected shape) yields `null` — never 0, never -1. `null`
 * is exactly what `currentGatewayPid` means by "could not be confirmed", and
 * per spec F4's asymmetry `compare()` must keep that `awaiting-restart`,
 * never resolve it to `matches`.
 */
export async function readGatewayPid(nodeId: string, stationKey: string): Promise<number | null> {
  const health = await broker.request(nodeId, "health", { key: stationKey });
  if (!health.ok) return null;
  const parsed = VERB_RESULTS.health.safeParse(health.data);
  return parsed.success ? parsed.data.pid : null;
}

// ─── reconcileOnAdopt ──────────────────────────────────────────────────────────

/**
 * The sentence recorded against a station for one failed setting. A
 * `ConfigApplyError` prefixes its code, so a recorded reason can be told
 * apart by a reader who only has the text — the refusal a node named, a node
 * that could not be reached, and nothing being declared all read differently.
 */
function reasonFor(err: unknown): string {
  if (err instanceof ConfigApplyError) {
    return err.code ? `${err.code}: ${err.message}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * How many stations `reconcileOnAdopt` works on at once, and how long the
 * adoption is willing to wait for all of them.
 *
 * Adoption is a user-facing request (`POST /api/stations/adopt`), and
 * reconcile runs inside it. Every broker round trip it makes has the broker's
 * 15s default timeout, and a node that is CONNECTED BUT WEDGED pays that
 * timeout in full rather than failing fast — so running stations one after
 * another, each with several round trips of its own, let a 20-station adopt
 * run for ten minutes. The rows were already committed by then, so the
 * operator's client gave up long before the response and saw a failed
 * adoption of stations that were in fact adopted.
 *
 * Two bounds, because either alone is insufficient: concurrency keeps one
 * wedged station from holding up the others, and the deadline keeps a wedged
 * NODE (where every station is slow for the same reason, concurrently) from
 * holding up the response.
 *
 * The deadline is one broker timeout plus a little — NOT because a station's
 * pass is one round trip. It is `2 + 4n` serial round trips for `n` drifted
 * settings (`fetchRegistry`; then `config.observe` and `health` together;
 * then, per setting, `planFor`'s own `fetchRegistry`, `config.plan`,
 * `config.apply` and the post-write `health`) — about ten for two settings.
 * Sizing the cap to that work would mean a cap measured in minutes, which is
 * the unbounded adoption this bound exists to prevent, so the cap stays at
 * one round trip and detaching is an ORDINARY outcome rather than an
 * exceptional one: a merely slow node, not only a wedged one, reaches it.
 *
 * That is why an unfinished station's outcome is `"pending"` and not
 * `"failed"`. Nothing has failed when the deadline fires — the pass is still
 * running, will finish, and will record its own `stations.configReason`. An
 * operator told "failed" about a station that then succeeds has been
 * misinformed by the label, not by the work.
 *
 * Passing the deadline never fails the adoption and never cancels the work:
 * the remaining stations keep reconciling, detached, and keep recording their
 * own `stations.configReason`.
 */
export const RECONCILE_CONCURRENCY = 6;
export const RECONCILE_DEADLINE_MS = 16_000;

/**
 * What `reconcileOnAdopt` did with one declared setting on one station.
 *
 * `"pending"` is not a failure and not a success: the pass was still running
 * when the adoption stopped waiting for it (`RECONCILE_DEADLINE_MS`), and it
 * records its own outcome against the station when it finishes. It is a
 * distinct result because the deadline is reached by a merely SLOW node, not
 * only a wedged one — see those constants.
 */
export interface ReconcileOutcome {
  stationId: string;
  settingId: string;
  result: "applied" | "skipped" | "failed" | "pending";
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
 * **Bounded.** Stations run concurrently (`RECONCILE_CONCURRENCY`) and the
 * whole pass is capped (`RECONCILE_DEADLINE_MS`); past the cap the adoption
 * returns and the rest keeps going detached, still recording its own reasons.
 * See those constants for why a serial pass could hold an adoption for
 * minutes.
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
  /**
   * Overridable only so a test can exercise the deadline without waiting a
   * real broker timeout for it. `adoptStations` — the one production caller —
   * passes nothing and gets the constants above.
   */
  bounds: { concurrency?: number; deadlineMs?: number } = {},
): Promise<ReconcileOutcome[]> {
  const concurrency = bounds.concurrency ?? RECONCILE_CONCURRENCY;
  const deadlineMs = bounds.deadlineMs ?? RECONCILE_DEADLINE_MS;
  // Outcomes are collected per index and flattened at the end, so running
  // stations concurrently does not shuffle the order a caller sees.
  const perStation: ReconcileOutcome[][] = adoptedStations.map(() => []);
  const finished = adoptedStations.map(() => false);

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const station = adoptedStations[i];
      if (!station) return;
      try {
        perStation[i] = await reconcileStation(tenantId, station);
      } catch (err) {
        // `reconcileStation` is written to swallow every failure itself; this
        // catch is defense in depth only, so a bug in the line above can
        // never undo an adoption whose rows are already committed.
        const reason = reasonFor(err);
        perStation[i] = [{ stationId: station.id, settingId: "*", result: "failed", reason }];
        await setConfigReason(station.id, reason);
      }
      finished[i] = true;
    }
  };

  const running = Promise.all(
    Array.from({ length: Math.min(concurrency, adoptedStations.length) }, worker),
  );

  let onDeadline: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    onDeadline = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const raced = await Promise.race([running.then(() => "done" as const), deadline]);
  if (onDeadline) clearTimeout(onDeadline);

  if (raced === "deadline") {
    // Detached, not cancelled: each station's work keeps going and keeps
    // recording its own `stations.configReason`, so nothing is lost — the
    // adoption simply stops waiting for it. `.catch` is required because
    // nothing awaits this promise any more and an unhandled rejection here
    // would be a crash on a path whose whole point is that it cannot fail an
    // adoption.
    void running.catch(() => {});
    for (const [i, station] of adoptedStations.entries()) {
      if (finished[i]) continue;
      perStation[i] = [
        {
          stationId: station.id,
          settingId: "*",
          result: "pending",
          reason: `declared settings were still being reconciled after ${deadlineMs}ms; the adoption did not wait, and this station records its own outcome when it finishes`,
        },
      ];
    }
  }

  return perStation.flat();
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

  const optedOut = await getOptOuts(tenantId, station.stationKey);

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
    // The health read for restart evidence is a second broker round trip to
    // the same node as `config.observe` — issued concurrently with it (and
    // with the `applied_harness_config` read, a DB query) rather than after,
    // so adding Task 9b's restart evidence does not add a serial round trip
    // to every reconcile.
    const [observeResult, appliedWrites, currentGatewayPid] = await Promise.all([
      broker.request(station.nodeId, "config.observe", {
        stationKey: station.stationKey,
        settings: candidateIds,
      }),
      getAppliedWrites(tenantId, station.id),
      readGatewayPid(station.nodeId, station.stationKey),
    ]);
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

    const observations = compare({
      stationId: station.id,
      declared,
      values,
      settings: settingsForCompare,
      appliedWrites,
      currentGatewayPid,
      optedOut,
    });

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
        // `candidateIds` already excludes an opted-out setting (above), so
        // `planFor`'s own opt-out check never fires here — this call always
        // names exactly one setting this station is not opted out of.
        const { plan } = await planFor({ tenantId, station, settings: [{ settingId: obs.settingId }] });
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
        // A `ConfigApplyError` carries the refusal's own code — the node's,
        // when the node is the one that refused — and the recorded reason
        // names it, so `stations.configReason` says what was refused rather
        // than only how it read.
        const reason = reasonFor(err);
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
