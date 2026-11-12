/**
 * The roster read endpoint Superlibrary calls with its own service token, and the station-owner read
 * beside it (`GET /api/bridge/stations/:id`: whose station it is, same allowlist, same tenant scope).
 *
 * `GET /api/bridge/boards/:boardId/roster` is the board's side of the same roster, for a placement
 * service (SuperDispatch) choosing among the agents that claim from a board: every bridge row on
 * the board, its station's principal, whether the bridge would claim on that station now (the same
 * readiness answer the console shows), whether the station has work in hand on any board, and when
 * it last took work. Reads only; the allowlist is the same `ROSTER_READERS`.
 *
 * Mounted AHEAD of `authMiddleware` and resolving its own auth, like `/mcp`: `authMiddleware`
 * refuses any non-human principal, and the caller here is a service. Verification is
 * `verifyPlaneBearer`, the one shared verifier. Which services may read is `ROSTER_READERS`,
 * read at request time so the operator's change needs a restart of nothing but the env.
 */
import { Hono, type Context } from "hono";
import { and, eq, inArray, max, sql } from "drizzle-orm";

import { db } from "../db/drizzle";
import { bridgeAgents, bridgeDispatches } from "../db/schema/bridge";
import { stations } from "../db/schema/stations";
import { verifyPlaneBearer } from "../auth/hub-token";
import { bridgeReadiness, checkBridgeDispatchGrant, probeSalaamWork } from "../services/bridge";
import * as acp from "../services/acp";
import { isControlPairEnforced } from "../services/control";

const STATION = /^[A-Za-z0-9_-]{1,100}$/;
const PRN = /^prn_[0-9a-f]{20}$/;
const BOARD = /^brd_[0-9a-f]{16}$/;

/**
 * Outcomes that mean a dispatch still has its station's attention: a run in progress, including one
 * waiting on a person's answer to a permission request (still `working`, with a wait deadline).
 * A `parked` run is not one: #786 parks a revoked strict run that never reported precisely so it no
 * longer holds the roster and the bridge claims new work on the station, so counting it here would
 * call a station busy forever while the bridge keeps claiming on it.
 */
const IN_HAND = ["working"] as const;

/** How long one station's readiness may take before it counts as not ready. */
export const ROSTER_READINESS_TIMEOUT_MS = 5_000;

/** One bridge row on a board, as the board roster read answers it, before readiness. */
export interface BoardRosterRow {
  key: string;
  stationId: string;
  /** The station's agent principal; null for a station with no agent yet. */
  principalId: string | null;
  enabled: boolean;
  /** The station has a dispatch in hand on any board of the workspace. */
  busy: boolean;
  /** When the station last took a dispatch, on any board; null when it never has. */
  lastDispatchedAt: string | null;
}

/** One bridge row on a board, with the bridge's readiness answer for its station. */
export interface BoardRosterEntry extends BoardRosterRow {
  ready: boolean;
  /** Why not, in the words the bridge logs. Null when ready. */
  reason: string | null;
}

/**
 * Every bridge row on a board in this tenant, enabled or not, with its station's principal and the
 * station's work across every board: in hand now, and the last time it took any.
 */
export async function boardRosterFor(tenantId: string, boardId: string): Promise<BoardRosterRow[]> {
  const rows = await db
    .select({
      key: bridgeAgents.key,
      stationId: bridgeAgents.stationId,
      principalId: stations.principalId,
      enabled: bridgeAgents.enabled,
    })
    .from(bridgeAgents)
    .innerJoin(
      stations,
      and(eq(stations.id, bridgeAgents.stationId), eq(stations.tenantId, bridgeAgents.tenantId)),
    )
    .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.boardId, boardId)))
    .orderBy(bridgeAgents.key);
  if (rows.length === 0) return [];
  const stationIds = [...new Set(rows.map((r) => r.stationId))];
  const work = await db
    .select({
      stationId: bridgeDispatches.stationId,
      inHand: sql<number>`count(*) filter (where ${inArray(bridgeDispatches.outcome, [...IN_HAND])})`.mapWith(Number),
      lastAt: max(bridgeDispatches.startedAt),
    })
    .from(bridgeDispatches)
    .where(and(eq(bridgeDispatches.tenantId, tenantId), inArray(bridgeDispatches.stationId, stationIds)))
    .groupBy(bridgeDispatches.stationId);
  const byStation = new Map(work.map((w) => [w.stationId, w]));
  return rows.map((r) => {
    const w = byStation.get(r.stationId);
    return {
      ...r,
      busy: (w?.inHand ?? 0) > 0,
      lastDispatchedAt: w?.lastAt ? new Date(w.lastAt).toISOString() : null,
    };
  });
}

/** The bridge's readiness answer for a station, bounded: a station that does not answer is not ready. */
async function readinessFor(tenantId: string, stationId: string): Promise<{ ready: boolean; reason: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ ready: boolean; reason: string | null }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ready: false, reason: `the station did not answer a readiness probe within ${ROSTER_READINESS_TIMEOUT_MS}ms` }),
      ROSTER_READINESS_TIMEOUT_MS,
    );
  });
  try {
    const answer = bridgeReadiness({ tenantId }, stationId, {
      strictWork: probeSalaamWork,
      stationReady: acp.stationReadiness,
      dispatchGrant: (sc, id) => checkBridgeDispatchGrant(sc.tenantId, id),
      pairEnforced: isControlPairEnforced(),
    }).then(
      (r) => ({ ready: r.ready, reason: r.reason }),
      () => ({ ready: false, reason: "the readiness probe failed" }),
    );
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The board roster with each station's readiness, asked of every station at once. */
export async function boardRosterWithReadiness(
  tenantId: string,
  boardId: string,
  deps: {
    rows?: typeof boardRosterFor;
    readiness?: (tenantId: string, stationId: string) => Promise<{ ready: boolean; reason: string | null }>;
  } = {},
): Promise<BoardRosterEntry[]> {
  const rows = await (deps.rows ?? boardRosterFor)(tenantId, boardId);
  const ask = deps.readiness ?? readinessFor;
  return Promise.all(
    rows.map(async (r) => {
      // A disabled row is never claimed on, so its station is not asked.
      if (!r.enabled) return { ...r, ready: false, reason: "the roster entry is disabled" };
      return { ...r, ...(await ask(tenantId, r.stationId)) };
    }),
  );
}

/** Superlibrary spec section 4: an agent sees the boards it holds an enabled bridge row on. */
export async function rosterBoardsFor(tenantId: string, prn: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ boardId: bridgeAgents.boardId })
    .from(bridgeAgents)
    .innerJoin(
      stations,
      and(eq(stations.id, bridgeAgents.stationId), eq(stations.tenantId, bridgeAgents.tenantId)),
    )
    .where(
      and(
        eq(bridgeAgents.tenantId, tenantId),
        eq(bridgeAgents.enabled, true),
        eq(stations.principalId, prn),
      ),
    );
  return rows.map((r) => r.boardId).sort();
}

/** Superlibrary gap S1: whose station this is, in the caller's tenant. Superlibrary records a person's console link only for its owner. */
export async function stationOwnerFor(
  tenantId: string,
  stationId: string,
): Promise<{ id: string; key: string; owner: string } | null> {
  const [r] = await db
    .select({ id: stations.id, key: stations.stationKey, owner: stations.userId })
    .from(stations)
    .where(and(eq(stations.id, stationId), eq(stations.tenantId, tenantId)))
    .limit(1);
  return r ?? null;
}

export interface BridgeRosterDeps {
  verify: (token: string) => ReturnType<typeof verifyPlaneBearer>;
  readers: () => string[];
  boards: (tenantId: string, prn: string) => Promise<string[]>;
  station: (tenantId: string, stationId: string) => Promise<{ id: string; key: string; owner: string } | null>;
  boardRoster: (tenantId: string, boardId: string) => Promise<BoardRosterEntry[]>;
}

const defaults: BridgeRosterDeps = {
  verify: (t) => verifyPlaneBearer(t),
  readers: () =>
    (process.env.ROSTER_READERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  boards: rosterBoardsFor,
  station: stationOwnerFor,
  boardRoster: (tenantId, boardId) => boardRosterWithReadiness(tenantId, boardId),
};

export function createBridgeRosterRoute(deps: BridgeRosterDeps = defaults) {
  /** The verified, allowlisted service caller, or the refusal to send. Both reads share it. */
  async function reader(c: Context): Promise<{ tenantId: string } | Response> {
    const match = /^Bearer +(\S+)$/i.exec((c.req.header("authorization") ?? "").trim());
    if (!match) return c.json({ error: "unauthorized" }, 401);
    const r = await deps.verify(match[1]!);
    if (!r.ok) return c.json(r.status === 403 ? r.body : { error: "unauthorized" }, r.status);
    if (r.caller.principalKind !== "service" || !deps.readers().includes(r.caller.sub)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return { tenantId: r.caller.tenantId };
  }

  return new Hono()
    .get("/api/bridge/principals/:prn/boards", async (c) => {
      const r = await reader(c);
      if (r instanceof Response) return r;
      const prn = c.req.param("prn");
      if (!PRN.test(prn)) return c.json({ error: "invalid principal" }, 400);
      return c.json({ boards: await deps.boards(r.tenantId, prn) });
    })
    .get("/api/bridge/stations/:id", async (c) => {
      const r = await reader(c);
      if (r instanceof Response) return r;
      const id = c.req.param("id");
      if (!STATION.test(id)) return c.json({ error: "invalid station" }, 400);
      const s = await deps.station(r.tenantId, id);
      return s ? c.json(s) : c.json({ error: "not found" }, 404);
    })
    .get("/api/bridge/boards/:boardId/roster", async (c) => {
      const r = await reader(c);
      if (r instanceof Response) return r;
      const boardId = c.req.param("boardId");
      if (!BOARD.test(boardId)) return c.json({ error: "invalid board" }, 400);
      return c.json({ boardId, agents: await deps.boardRoster(r.tenantId, boardId) });
    });
}
