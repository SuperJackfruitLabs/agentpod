/**
 * Declared harness configuration — the HTTP surface for Tasks 5-6's store and
 * comparison (`services/harness-config.ts`).
 *
 *   GET    /api/fleet/config/settings      → { settings, unreachableNodes }
 *   GET    /api/fleet/config/declared      → DeclaredHarnessConfigRow[] (?station=, ?node=)
 *   PUT    /api/fleet/config/declared      → declare one setting at one level
 *   DELETE /api/fleet/config/declared      → undeclare one setting at one level
 *   GET    /api/fleet/config/drift         → { observations, stationsUnreachable }
 *   GET    /api/stations/:stationId/config → { observations }
 *
 * Shape follows `apps/hub/src/routes/station-acp.ts`: a chained `Hono()`
 * export mounted at `/api` (so routes here read as `/api/fleet/...` and
 * `/api/stations/:id/config`), `AuthUser` read off `c.get("user")` (set by
 * `authMiddleware`, which already ran in `index.ts`), `getStation(userId, id)`
 * plus a `tenantId` check for per-station ownership, and `broker.request` for
 * the node round trip — the same four ingredients `station-skills.ts` and
 * `station-cleanup.ts` use.
 *
 * **Non-human principals are refused on every route in this file** — `service`
 * as well as `agent`, fail-closed on the kind rather than on a list.
 * `fleet-dispatchable.ts` and `missions.ts` draw the same line: an agent's
 * authority is to be dispatched, never to operate the fleet that dispatches
 * it, and these routes declare fleet policy — what the fleet wants a setting
 * to be. No route here is the exception that gets to skip the check.
 *
 * **The Task 6 caller contract.** `compare()` iterates `values` and silently
 * drops a declared setting that has no matching `ConfigValue` — neither
 * `absent` nor `unreadable`, just missing from the report. `observeStation`
 * below is the one place that calls `compare()`, and it is written so that
 * EVERY settingId it asks about gets a `ConfigValue` before `compare()` ever
 * sees it: a broker failure (offline node, timeout, a bad or short response)
 * synthesises `{settingId, readable: false, reason}` for every one of them,
 * never a partial list. A route that answered `matches` for a station it
 * could not reach would report agreement it never observed — the exact
 * failure this feature exists to end.
 *
 * **No registry is held in this file.** An earlier version of this route
 * carried a static `KNOWN_SETTINGS` constant, hand-copied from the node's
 * `hermesConfigRegistry` — rejected on review, correctly: two copies of a
 * registry is the exact defect this feature exists to DETECT (a value true
 * when written, with nothing watching it keep agreeing), and shipping that
 * inside a feature about catching drift would refute the feature. Every
 * `ConfigSetting[]` used below is fetched live, per request, from the node
 * that actually holds the registry, via the broker's `config.settings` verb
 * (`apps/node-agent/internal/descriptor/handler.go`) — the sibling of
 * `config.observe` that answers "what can you manage" instead of "what do
 * you currently have".
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  DeclaredSetting,
  ConfigReceipt,
  type ConfigObservation,
  type ConfigSetting,
  type ConfigValue,
} from "@agentpod/contract";
import { db } from "../db/drizzle";
import { declaredHarnessConfig } from "../db/schema/harness-config";
import { stations } from "../db/schema/stations";
import { nodes } from "../db/schema/nodes";
import { tenantScope } from "../db/tenant-scope";
import * as broker from "../services/broker";
import { getStation, type StationRow } from "../services/station-registry";
import { declare, undeclare, resolveFor, compare, fetchRegistry, getOptOuts } from "../services/harness-config";
import { planFor, applyFor, ConfigApplyError, getAppliedWrites, readGatewayPid } from "../services/harness-config-apply";
import { principalForUser } from "../services/principals";
import type { AuthUser } from "../auth/middleware";

/** The capability a station must advertise to be a candidate for this feature. */
const CONFIG_MANAGE = "config.manage";

// ─── Shared helpers ─────────────────────────────────────────────────────────────

/** Every tenant station advertising `config.manage`, tenant-scoped. */
async function manageableStations(tenantId: string): Promise<StationRow[]> {
  const allStations = await db.select().from(stations).where(tenantScope(stations, tenantId));
  return allStations.filter(
    (s) => Array.isArray(s.capabilities) && s.capabilities.includes(CONFIG_MANAGE),
  );
}

/** Node ids this tenant's nodes table currently records as online. */
async function onlineNodeIds(tenantId: string): Promise<Set<string>> {
  const allNodes = await db.select().from(nodes).where(tenantScope(nodes, tenantId));
  return new Set(allNodes.filter((n) => n.status === "online").map((n) => n.id));
}

/**
 * Resolve one `settingId` against the LIVE registry, so `PUT` never has to
 * trust a copy. `hint` narrows which station(s) may answer — the exact
 * target the caller named, when one was named — because a declaration
 * naming a station or node is a claim about THAT station's or node's
 * harness, not about whichever one happens to answer first.
 *
 * If no candidate can currently be asked, the declaration is REFUSED, not
 * accepted by default: admitting a setting nobody could verify is the same
 * failure as reporting agreement for a station nobody could reach — the
 * write-side mirror of the read-side `unreadable` rule.
 */
async function verifySettingKnown(
  settingId: string,
  tenantId: string,
  hint: { stationId: string | null; nodeId: string | null },
): Promise<{ ok: true; setting: ConfigSetting } | { ok: false; reason: string }> {
  const manageable = await manageableStations(tenantId);

  let pool = manageable;
  if (hint.stationId) pool = pool.filter((s) => s.id === hint.stationId);
  else if (hint.nodeId) pool = pool.filter((s) => s.nodeId === hint.nodeId);

  // Settings are namespaced "<harness>.<path>" (spec D1). Preferring a
  // harness-matching station keeps a fleet-level declaration from being
  // answered by an unrelated harness's registry when more than one is
  // present; falling back to the full pool only when nothing matches the
  // namespace at all still lets an unexpected id be looked up rather than
  // refused for a reason that has nothing to do with it.
  const harness = settingId.split(".")[0];
  const harnessMatched = pool.filter((s) => s.harness === harness);
  const candidates = harnessMatched.length > 0 ? harnessMatched : pool;

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no station in this tenant could be asked to confirm this setting's registry",
    };
  }

  // Try every candidate before refusing. A `continue` on "this one doesn't
  // know it" rather than an early `return` is load-bearing on the fallback
  // path: when nothing matched the harness-prefix heuristic above, `pool`
  // (and so `candidates`) can hold stations of SEVERAL unrelated harnesses,
  // and the first one to answer is not authoritative for the others. Only
  // after every reachable candidate has been asked, and none confirmed the
  // id, is it genuinely unknown.
  //
  // One ask per (node, harness) PAIR, not per station — the same
  // de-duplication `GET /fleet/config/settings` does below, and for the same
  // reason: a registry is the harness's, not the station's, so a second
  // station on the same node under the same harness answers an identical
  // question. A 30-profile Hermes host made that 30 identical `config.settings`
  // calls for one id, and one online-but-hung node could hold a single `PUT`
  // for 30 × the broker timeout.
  const online = await onlineNodeIds(tenantId);
  const askedPairs = new Set<string>();
  let askedAny = false;
  for (const station of candidates) {
    if (!online.has(station.nodeId)) continue;
    const pair = `${station.nodeId}\u0000${station.harness}`;
    if (askedPairs.has(pair)) continue;
    askedPairs.add(pair);
    const registry = await fetchRegistry(station.nodeId, station.stationKey);
    if (registry === null) continue;
    askedAny = true;
    const found = registry.find((s) => s.id === settingId);
    if (found) return { ok: true, setting: found };
  }

  if (askedAny) {
    return { ok: false, reason: `${settingId} is not a setting any reachable harness manages` };
  }
  return {
    ok: false,
    reason: "the registry could not be read: no reachable node could confirm this setting",
  };
}

/**
 * NON-HUMAN principals are refused on every route below — `service` as well as
 * `agent`. `null` means the caller may proceed (a human, or a caller with no
 * principal row at all — every caller was treated as human before principals
 * existed, and this endpoint fails open on "unmapped" for the same reason
 * `principalForUser` returning null never 403s elsewhere: a bootstrap caller
 * with no row yet is not a non-human one).
 *
 * Fail-closed on the KIND, not a list of refused kinds. This file's header
 * claims parity with `fleet-dispatchable.ts`, which refuses any
 * `principalKind !== "human"`, and `auth/middleware.ts` refuses a non-human
 * hub token outright before a route is reached. Naming `agent` alone was a
 * third, looser answer to the same question, reachable through the non-hub-token
 * auth paths: it admitted `service` — the third kind the principals table
 * allows — to routes that declare FLEET POLICY. Nothing in this repo calls
 * these routes with a service principal (the only in-repo caller is
 * `fleet config`, a human CLI), so closing it breaks nothing and a route later
 * audited as correct for a service can opt in from a position where the
 * default was closed.
 */
async function nonHumanRefusal(user: AuthUser): Promise<{ error: string } | null> {
  const principal = await principalForUser(user.id);
  if (principal && principal.kind !== "human") {
    return {
      error:
        `This endpoint takes a human principal. Declared configuration is fleet policy, not a station a ${principal.kind} principal is dispatched to work in.`,
    };
  }
  return null;
}

/**
 * Fill in any settingId the node's response did not cover, so `compare()`
 * never receives a short list. Covers both total failure (no response at
 * all) and a partial one (the node answered but left an id out) with the one
 * guarantee this file exists to uphold.
 */
function ensureEveryValue(
  settingIds: string[],
  values: ConfigValue[],
  reason: string,
): ConfigValue[] {
  const byId = new Map(values.map((v) => [v.settingId, v]));
  return settingIds.map((id) => byId.get(id) ?? { settingId: id, readable: false, reason });
}

/**
 * Observe one station: resolve its declarations, ask the node for the
 * current values AND its registry (in parallel — two different questions to
 * the same node), and compare. Returns `unreachable: true` whenever the
 * VALUES call failed (offline node, timeout, disconnect) — distinct from the
 * per-setting `unreadable` state in `observations`, because a station with
 * nothing declared yields zero observations on a failed call just as it
 * would on a successful one, and the caller (the drift route) still needs
 * to know it could not be asked.
 *
 * A registry fetch that fails independently of the values call degrades
 * gracefully rather than failing the whole observation: `compare()`'s
 * out-of-scope rule needs a setting's `scope` to fire, and without it the
 * row falls through to the ordinary matches/drifted/absent/unreadable
 * states — correct in the common case this happens, which is the SAME node
 * failing both calls, where every row is already `unreadable` regardless.
 *
 * Also feeds `compare()`'s three Task 9b arguments — `appliedWrites`
 * (`applied_harness_config`, via `getAppliedWrites`), `currentGatewayPid`
 * (the station's live health, via `readGatewayPid`) and `optedOut` (via
 * `getOptOuts`) — the restart evidence and opt-out an earlier task's
 * `compare()` could already emit but no caller fed it, so `awaiting-restart`
 * and `opted-out` could never reach either route that calls this function
 * (`GET /api/fleet/config/drift` and `GET /api/stations/:stationId/config`).
 * The health read is a SECOND broker round trip to the same node as
 * `config.observe` — issued concurrently with it (and the registry fetch,
 * and the two DB reads) rather than serially after, so `GET
 * /api/fleet/config/drift`'s fan-out across every station does not double in
 * wall-clock time for a correctness fix.
 */
async function observeStation(
  station: Pick<StationRow, "id" | "nodeId" | "stationKey">,
  tenantId: string,
): Promise<{ observations: ConfigObservation[]; unreachable: boolean }> {
  const declared = await resolveFor(station.id, station.nodeId, tenantId);
  const settingIds = Object.keys(declared);
  if (settingIds.length === 0) {
    return { observations: [], unreachable: false };
  }

  const [registry, result, appliedWrites, currentGatewayPid, optedOut] = await Promise.all([
    fetchRegistry(station.nodeId, station.stationKey),
    broker.request(station.nodeId, "config.observe", {
      stationKey: station.stationKey,
      settings: settingIds,
    }),
    getAppliedWrites(tenantId, station.id),
    readGatewayPid(station.nodeId, station.stationKey),
    getOptOuts(tenantId, station.stationKey),
  ]);

  const raw = result.ok
    ? ((result.data as { values?: ConfigValue[] } | undefined)?.values ?? [])
    : [];
  const reason = result.ok
    ? "the node did not return a value for every requested setting"
    : (result.error ?? "the node could not be reached");
  const values = ensureEveryValue(settingIds, raw, reason);

  const registryById = new Map((registry ?? []).map((s) => [s.id, s]));
  const settings = settingIds
    .map((id) => registryById.get(id))
    .filter((s): s is ConfigSetting => s !== undefined);

  return {
    observations: compare({
      stationId: station.id,
      declared,
      values,
      settings,
      appliedWrites,
      currentGatewayPid,
      optedOut,
    }),
    unreachable: !result.ok,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const UndeclareBody = z
  .object({
    settingId: z.string().min(1),
    stationId: z.string().nullable(),
    nodeId: z.string().nullable(),
  })
  .refine((d) => !(d.stationId !== null && d.nodeId !== null), {
    message: "a declaration targets one level: station, node, or fleet (both null)",
  });

/**
 * Body of `POST /stations/:stationId/config/plan`. `value` is optional per
 * entry — an omitted one resolves from this station's declaration
 * (`planFor`'s job, not this schema's: zod cannot see what is declared).
 */
const PlanBody = z.object({
  settings: z.array(z.object({ settingId: z.string().min(1), value: z.unknown().optional() })).min(1),
});

/** Body of `POST /stations/:stationId/config/apply`. */
const ApplyBody = z.object({
  operationId: z.string().min(1),
  planDigest: z.string().min(1),
});

/**
 * `ConfigApplyError` → the status/body the route answers with.
 *
 * `code` travels verbatim, including a refusal code the NODE produced
 * (`planFor` throws rather than returning a refused plan as though it were a
 * plan — finding 3). A caller distinguishes a refusal from a plan by the
 * status alone, and which refusal it was by `code` alone, without parsing the
 * sentence.
 */
function configApplyErrorResponse(err: ConfigApplyError): { error: string; code?: string } {
  return { error: err.message, ...(err.code ? { code: err.code } : {}) };
}

export const harnessConfigRoutes = new Hono()

  /**
   * GET /api/fleet/config/settings
   *
   * The union of every REACHABLE node's `ConfigSettings()`, de-duplicated by
   * id. A node with a `config.manage` station that is currently offline
   * contributes nothing to `settings` (claiming a setting is manageable via
   * a node nobody can currently ask would be the exact lie this feature
   * exists to end) but is still named in `unreachableNodes` — never silently
   * dropped from the answer.
   */
  .get("/fleet/config/settings", async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const tenantId = user.tenantId;
    const manageable = await manageableStations(tenantId);
    const online = await onlineNodeIds(tenantId);

    // One representative station per (node, harness) pair — the registry is
    // the harness's, not the station's, so asking twice for the same pair
    // would be two round trips for one answer.
    const seen = new Set<string>();
    const representatives: StationRow[] = [];
    for (const s of manageable) {
      const key = `${s.nodeId}\u0000${s.harness}`;
      if (seen.has(key)) continue;
      seen.add(key);
      representatives.push(s);
    }

    const settingsById = new Map<string, ConfigSetting>();
    const unreachableNodes = new Set<string>();

    for (const station of representatives) {
      if (!online.has(station.nodeId)) {
        unreachableNodes.add(station.nodeId);
        continue;
      }
      const registry = await fetchRegistry(station.nodeId, station.stationKey);
      if (registry === null) {
        unreachableNodes.add(station.nodeId);
        continue;
      }
      for (const s of registry) settingsById.set(s.id, s);
    }

    return c.json({
      settings: Array.from(settingsById.values()),
      unreachableNodes: Array.from(unreachableNodes),
    });
  })

  /**
   * GET /api/fleet/config/declared?station=&node=
   *
   * Every declaration for the tenant. `?station=`/`?node=` are optional
   * filters — required because `fleet config show --node` calls this with
   * `?node=` and, without the filter, would silently get the whole fleet's
   * declarations back instead of just that node's.
   */
  .get("/fleet/config/declared", async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const stationId = c.req.query("station");
    const nodeId = c.req.query("node");
    const extra = [
      stationId ? eq(declaredHarnessConfig.stationId, stationId) : undefined,
      nodeId ? eq(declaredHarnessConfig.nodeId, nodeId) : undefined,
    ];

    const rows = await db
      .select()
      .from(declaredHarnessConfig)
      .where(tenantScope(declaredHarnessConfig, user.tenantId, ...extra));
    return c.json(rows);
  })

  /**
   * PUT /api/fleet/config/declared
   *
   * Body: `DeclaredSetting` (contract). The contract's own `.refine()`
   * already rejects a body naming both `stationId` and `nodeId` — zValidator
   * surfaces that as this route's 400, not a 500, because the refusal
   * happens before any handler code runs.
   *
   * A `settingId` no reachable registry knows is refused by name
   * (`UNKNOWN_SETTING`, D1): this system declares named settings only, never
   * one sight-unseen. The registry is read live from the node named by the
   * declaration's own target (its station, its node, or — for a fleet-level
   * declaration — any reachable station of the matching harness); when
   * nothing can currently be asked, the declaration is refused rather than
   * accepted on trust (`verifySettingKnown`).
   */
  .put("/fleet/config/declared", zValidator("json", DeclaredSetting), async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const body = c.req.valid("json");
    const verdict = await verifySettingKnown(body.settingId, user.tenantId, {
      stationId: body.stationId,
      nodeId: body.nodeId,
    });
    if (!verdict.ok) {
      return c.json({ error: "UNKNOWN_SETTING", settingId: body.settingId, reason: verdict.reason }, 400);
    }

    try {
      await declare({
        settingId: body.settingId,
        stationId: body.stationId,
        nodeId: body.nodeId,
        value: body.value,
        tenantId: user.tenantId,
        declaredBy: user.id,
      });
    } catch (err) {
      // Defense in depth: declare()'s own assertOneLevel should never fire
      // here because the contract's refine already rejected two levels, but
      // a service-level refusal is still a client error, not a 500.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.body(null, 204);
  })

  /**
   * DELETE /api/fleet/config/declared
   *
   * Body: `{settingId, stationId, nodeId}`, the same one-level shape as PUT
   * minus `value`. A level with no declaration is a no-op (see `undeclare`).
   */
  .delete("/fleet/config/declared", zValidator("json", UndeclareBody), async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const body = c.req.valid("json");
    try {
      await undeclare({
        settingId: body.settingId,
        stationId: body.stationId,
        nodeId: body.nodeId,
        tenantId: user.tenantId,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.body(null, 204);
  })

  /**
   * GET /api/fleet/config/drift
   *
   * Fans `observeStation` across every station in the tenant advertising
   * `config.manage`, keeps only observations whose state is not `matches`,
   * and carries `stationsUnreachable` — the stations whose broker call
   * failed outright — for the same reason a project rollup admits a board it
   * could not read: a total that silently omits a station is worse than one
   * that says it is incomplete.
   */
  .get("/fleet/config/drift", async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const tenantId = user.tenantId;
    const candidates = await manageableStations(tenantId);

    const observations: ConfigObservation[] = [];
    const stationsUnreachable: string[] = [];
    for (const station of candidates) {
      const result = await observeStation(station, tenantId);
      if (result.unreachable) stationsUnreachable.push(station.id);
      for (const o of result.observations) {
        if (o.state !== "matches") observations.push(o);
      }
    }

    return c.json({ observations, stationsUnreachable });
  })

  /**
   * GET /api/stations/:stationId/config
   *
   * `resolveFor` + broker `config.observe` + `compare` for one station,
   * scoped to the caller the same way `station-skills.ts` and
   * `station-cleanup.ts` are: `getStation(userId, id)` plus a tenant check.
   * Always 200 when the station is found — a broker failure still answers
   * with honest `unreadable` rows rather than a 502, because the caller
   * asked "what does this station have", and "we could not find out" is an
   * answer to that question, not a failure to produce one.
   */
  .get("/stations/:stationId/config", async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const stationId = c.req.param("stationId");
    const station = await getStation(user.id, stationId);
    if (!station || station.tenantId !== user.tenantId) {
      return c.json({ error: "Not Found" }, 404);
    }

    const { observations } = await observeStation(station, user.tenantId);
    return c.json({ observations });
  })

  /**
   * POST /api/stations/:stationId/config/plan
   *
   * Body: `{settings: [{settingId, value?}]}`. Resolves a station the same
   * way every route in this file does (`getStation` + tenant check), then
   * hands off to `planFor` (`services/harness-config-apply.ts`), which
   * checks every id against the LIVE registry before the node is ever asked
   * to plan anything, resolves an omitted `value` from what is declared, and
   * returns the node's `ConfigPlan` unchanged — never an empty one standing
   * in for a node this system could not reach (that is a 502, via
   * `ConfigApplyError`, not a 200 with nothing in it), and never a REFUSED
   * plan standing in for a plan (that is a 400 or a 409 carrying the node's
   * own refusal code, for the same reason: a refusal that cannot be told from
   * a pass by status or exit code is spec §9's whole premise, violated).
   */
  .post("/stations/:stationId/config/plan", zValidator("json", PlanBody), async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const stationId = c.req.param("stationId");
    const station = await getStation(user.id, stationId);
    if (!station || station.tenantId !== user.tenantId) {
      return c.json({ error: "Not Found" }, 404);
    }

    const body = c.req.valid("json");
    try {
      const { plan, refused } = await planFor({ tenantId: user.tenantId, station, settings: body.settings });
      // `refused` is additive: a plan with nothing opted out answers with
      // exactly the node's `ConfigPlan`, unchanged, as every caller of this
      // route already expects. Only a mixed request (some settings opted
      // out, the rest planned) carries the extra field, naming what was
      // left out and why.
      return c.json(refused.length > 0 ? { ...plan, refused } : plan);
    } catch (err) {
      if (err instanceof ConfigApplyError) {
        return c.json(configApplyErrorResponse(err), err.status as 400 | 409 | 502);
      }
      throw err;
    }
  })

  /**
   * GET /api/stations/:stationId/config/operations/:operationId
   *
   * Reads the receipt this station's own node journal has recorded for
   * `operationId`, exactly as the node reports it — this route never
   * re-derives or re-plans (`config.inspect`, the sibling of `config.plan`
   * and `config.apply`).
   */
  .get("/stations/:stationId/config/operations/:operationId", async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const stationId = c.req.param("stationId");
    const station = await getStation(user.id, stationId);
    if (!station || station.tenantId !== user.tenantId) {
      return c.json({ error: "Not Found" }, 404);
    }

    const operationId = c.req.param("operationId");
    const result = await broker.request(station.nodeId, "config.inspect", {
      stationKey: station.stationKey,
      operationId,
    });
    if (!result.ok) {
      return c.json({ error: result.error ?? "the node could not be reached" }, 502);
    }
    const parsed = ConfigReceipt.safeParse(result.data);
    if (!parsed.success) {
      return c.json({ error: "the node returned an unexpected receipt" }, 502);
    }
    return c.json(parsed.data);
  })

  /**
   * POST /api/stations/:stationId/config/apply
   *
   * Body: `{operationId, planDigest}`. Forwards to `applyFor`, which asks
   * the node to apply exactly the plan reviewed as `planDigest` for
   * `operationId`. The node — never this route — decides `applied` vs
   * `conflict` (a digest that no longer matches its journal is a conflict,
   * not an error; see `hermes_config.go`'s `ApplyConfig`), so the response
   * status mirrors that: 200 for `applied`, 409 for anything else. Only on
   * `applied` does `applyFor` record `applied_harness_config` rows, under
   * the gateway pid read from this station's health right after the write.
   */
  .post("/stations/:stationId/config/apply", zValidator("json", ApplyBody), async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await nonHumanRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const stationId = c.req.param("stationId");
    const station = await getStation(user.id, stationId);
    if (!station || station.tenantId !== user.tenantId) {
      return c.json({ error: "Not Found" }, 404);
    }

    const body = c.req.valid("json");
    try {
      const receipt = await applyFor({
        tenantId: user.tenantId,
        station,
        operationId: body.operationId,
        planDigest: body.planDigest,
      });
      return c.json(receipt, receipt.phase === "applied" ? 200 : 409);
    } catch (err) {
      if (err instanceof ConfigApplyError) {
        return c.json(configApplyErrorResponse(err), err.status as 400 | 409 | 502);
      }
      throw err;
    }
  });
