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
 * **Agent-kind principals are refused on every route in this file.**
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
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  DeclaredSetting,
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
import { declare, undeclare, resolveFor, compare } from "../services/harness-config";
import { principalForUser } from "../services/principals";
import type { AuthUser } from "../auth/middleware";

/** The capability a station must advertise to be a candidate for this feature. */
const CONFIG_MANAGE = "config.manage";

/**
 * The harness config registry this hub knows about.
 *
 * Mirrors `apps/node-agent/internal/descriptor/hermes_config.go`'s
 * `hermesConfigRegistry` exactly — same three ids, same scope/policy/restart.
 * There is no broker verb that returns `ConfigSettings()` remotely (Task 4
 * built only `config.observe`, which reads VALUES for ids the caller already
 * names), so until one exists this is the hub's own copy of the same list —
 * the identical duplication the contract's `ConfigSetting`/`ConfigValue` Go
 * JSON tags already carry across the node/hub boundary. Keep the two in sync
 * by hand; a mismatch here makes `UNKNOWN_SETTING` refuse an id the node
 * would honour, or admit one it would refuse.
 */
const KNOWN_SETTINGS: ConfigSetting[] = [
  {
    id: "hermes.approvals.timeout",
    harness: "hermes",
    scope: "profile",
    policy: "reconcilable",
    restartToTakeEffect: true,
  },
  {
    id: "hermes.approvals.mode",
    harness: "hermes",
    scope: "profile",
    policy: "reconcilable",
    restartToTakeEffect: true,
  },
  {
    id: "hermes.approvals.command_allowlist",
    harness: "hermes",
    scope: "profile",
    policy: "additive-only",
    restartToTakeEffect: true,
  },
];
const KNOWN_SETTINGS_BY_ID = new Map(KNOWN_SETTINGS.map((s) => [s.id, s]));

// ─── Shared helpers ─────────────────────────────────────────────────────────────

/**
 * Agent-kind principals are refused on every route below. `null` means the
 * caller may proceed (a human, or a caller with no principal row at all —
 * every caller was treated as human before principals existed, and this
 * endpoint fails open on "unmapped" for the same reason `principalForUser`
 * returning null never 403s elsewhere: a bootstrap caller with no row yet is
 * not an agent).
 */
async function agentRefusal(user: AuthUser): Promise<{ error: string } | null> {
  const principal = await principalForUser(user.id);
  if (principal?.kind === "agent") {
    return {
      error:
        "This endpoint takes a human principal. Declared configuration is fleet policy, not a station an agent is dispatched to work in.",
    };
  }
  return null;
}

/**
 * Every requested setting, synthesised as `readable: false` with the same
 * reason — the shape a route falls back to for EVERY settingId at once, never
 * a subset.
 */
function allUnreadable(settingIds: string[], reason: string): ConfigValue[] {
  return settingIds.map((settingId) => ({ settingId, readable: false, reason }));
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
 * current values, and compare. Returns `unreachable: true` whenever the
 * broker call itself failed (offline node, timeout, disconnect) — distinct
 * from the per-setting `unreadable` state in `observations`, because a
 * station with nothing declared yields zero observations on a failed call
 * just as it would on a successful one, and the caller (the drift route)
 * still needs to know it could not be asked.
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

  const result = await broker.request(station.nodeId, "config.observe", {
    stationKey: station.stationKey,
    settings: settingIds,
  });

  const raw = result.ok
    ? ((result.data as { values?: ConfigValue[] } | undefined)?.values ?? [])
    : [];
  const reason = result.ok
    ? "the node did not return a value for every requested setting"
    : (result.error ?? "the node could not be reached");
  const values = ensureEveryValue(settingIds, raw, reason);

  const settings = settingIds
    .map((id) => KNOWN_SETTINGS_BY_ID.get(id))
    .filter((s): s is ConfigSetting => s !== undefined);

  return {
    observations: compare({ stationId: station.id, declared, values, settings }),
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
    const refusal = await agentRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const tenantId = user.tenantId;
    const [allStations, allNodes] = await Promise.all([
      db.select().from(stations).where(tenantScope(stations, tenantId)),
      db.select().from(nodes).where(tenantScope(nodes, tenantId)),
    ]);
    const statusByNode = new Map(allNodes.map((n) => [n.id, n.status]));

    const harnessesByNode = new Map<string, Set<string>>();
    for (const s of allStations) {
      if (!Array.isArray(s.capabilities) || !s.capabilities.includes(CONFIG_MANAGE)) continue;
      const set = harnessesByNode.get(s.nodeId) ?? new Set<string>();
      set.add(s.harness);
      harnessesByNode.set(s.nodeId, set);
    }

    const reachableHarnesses = new Set<string>();
    const unreachableNodes: string[] = [];
    for (const [nodeId, harnesses] of harnessesByNode) {
      if (statusByNode.get(nodeId) === "online") {
        for (const h of harnesses) reachableHarnesses.add(h);
      } else {
        unreachableNodes.push(nodeId);
      }
    }

    const settings = KNOWN_SETTINGS.filter((s) => reachableHarnesses.has(s.harness));
    return c.json({ settings, unreachableNodes });
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
    const refusal = await agentRefusal(user);
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
   * A `settingId` no registry knows is refused by name (`UNKNOWN_SETTING`,
   * D1): this system declares named settings only, never one sight-unseen.
   */
  .put("/fleet/config/declared", zValidator("json", DeclaredSetting), async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return c.json({ error: "Unauthorized" }, 401);
    const refusal = await agentRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const body = c.req.valid("json");
    if (!KNOWN_SETTINGS_BY_ID.has(body.settingId)) {
      return c.json({ error: "UNKNOWN_SETTING", settingId: body.settingId }, 400);
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
    const refusal = await agentRefusal(user);
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
    const refusal = await agentRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const tenantId = user.tenantId;
    const allStations = await db.select().from(stations).where(tenantScope(stations, tenantId));
    const candidates = allStations.filter(
      (s) => Array.isArray(s.capabilities) && s.capabilities.includes(CONFIG_MANAGE),
    );

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
    const refusal = await agentRefusal(user);
    if (refusal) return c.json(refusal, 403);

    const stationId = c.req.param("stationId");
    const station = await getStation(user.id, stationId);
    if (!station || station.tenantId !== user.tenantId) {
      return c.json({ error: "Not Found" }, 404);
    }

    const { observations } = await observeStation(station, user.tenantId);
    return c.json({ observations });
  });
