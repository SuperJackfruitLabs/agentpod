/**
 * The roster read endpoint Superlibrary calls with its own service token.
 *
 * Mounted AHEAD of `authMiddleware` and resolving its own auth, like `/mcp`: `authMiddleware`
 * refuses any non-human principal, and the caller here is a service. Verification is
 * `verifyPlaneBearer`, the one shared verifier. Which services may read is `ROSTER_READERS`,
 * read at request time so the operator's change needs a restart of nothing but the env.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { bridgeAgents } from "../db/schema/bridge";
import { stations } from "../db/schema/stations";
import { verifyPlaneBearer } from "../auth/hub-token";

const PRN = /^prn_[0-9a-f]{20}$/;

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

export interface BridgeRosterDeps {
  verify: (token: string) => ReturnType<typeof verifyPlaneBearer>;
  readers: () => string[];
  boards: (tenantId: string, prn: string) => Promise<string[]>;
}

const defaults: BridgeRosterDeps = {
  verify: (t) => verifyPlaneBearer(t),
  readers: () =>
    (process.env.ROSTER_READERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  boards: rosterBoardsFor,
};

export function createBridgeRosterRoute(deps: BridgeRosterDeps = defaults) {
  return new Hono().get("/api/bridge/principals/:prn/boards", async (c) => {
    const match = /^Bearer +(\S+)$/i.exec((c.req.header("authorization") ?? "").trim());
    if (!match) return c.json({ error: "unauthorized" }, 401);
    const r = await deps.verify(match[1]!);
    if (!r.ok) return c.json(r.status === 403 ? r.body : { error: "unauthorized" }, r.status);
    if (r.caller.principalKind !== "service" || !deps.readers().includes(r.caller.sub)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const prn = c.req.param("prn");
    if (!PRN.test(prn)) return c.json({ error: "invalid principal" }, 400);
    return c.json({ boards: await deps.boards(r.caller.tenantId, prn) });
  });
}
