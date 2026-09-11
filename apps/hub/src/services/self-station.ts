/**
 * The station a principal occupies — the whole of an agent's self-scoping.
 *
 * # Why this is a function and not a `where` clause in each tool
 *
 * The route audit (`docs/superpowers/specs/2026-09-11-route-audit-for-agent-principals.md`)
 * concluded that the existing station routes are the wrong ones to open to an agent: they take a
 * station id, and an ownership check bolted on beside an id is a thing a future handler can
 * forget. The shape it endorsed instead is a surface with **no id to tamper with**, where the
 * station is derived from the caller's own principal.
 *
 * This is that derivation, in one place, so there is one thing to get right and one thing to
 * test. A tool that calls this cannot be pointed at somebody else's station, because it is never
 * given the opportunity to name one.
 *
 * `stations.principal_id` carries a partial unique index (`stations_principal_id_idx`, where not
 * null), so "the station this principal occupies" is a question with at most one answer. That
 * uniqueness is enforced by the schema, not assumed here — see
 * `charter → decisions/2026-08-30-an-agent-is-a-principal.md`, which made occupancy exclusive and
 * assignment a move.
 */
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";

export interface SelfStation {
  id: string;
  stationKey: string;
  nodeId: string;
  nodeName: string | null;
  nodeStatus: string | null;
  harness: string | null;
  matrixId: string | null;
  identityMode: string | null;
}

/**
 * The station this principal occupies, or null.
 *
 * **Null is an ordinary answer, not an error.** An agent between assignments occupies nothing,
 * and a caller should say so plainly rather than failing — "you are not currently placed in a
 * station" is true, useful, and not a fault anybody needs to investigate.
 */
export async function stationForPrincipal(principalId: string): Promise<SelfStation | null> {
  if (!principalId) return null;

  const [row] = await db
    .select({
      id: stations.id,
      stationKey: stations.stationKey,
      nodeId: stations.nodeId,
      nodeName: nodes.name,
      nodeStatus: nodes.status,
      harness: stations.harness,
      matrixId: stations.matrixId,
      identityMode: stations.matrixIdentityMode,
    })
    .from(stations)
    .leftJoin(nodes, eq(nodes.id, stations.nodeId))
    .where(and(eq(stations.principalId, principalId), isNotNull(stations.principalId)))
    .limit(1);

  return row ?? null;
}

/**
 * Does this principal occupy this station?
 *
 * For the one tool in slice 1 that unavoidably takes an id — a transcript is identified by its
 * session, not by a station — so ownership has to be checked rather than made impossible. It is
 * the exception, it is named in the spec, and it has its own test.
 */
export async function principalOccupies(principalId: string, stationId: string): Promise<boolean> {
  if (!principalId || !stationId) return false;
  const station = await stationForPrincipal(principalId);
  return station?.id === stationId;
}
