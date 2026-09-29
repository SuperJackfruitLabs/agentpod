/**
 * Who a plugin's fleet report is from, and whose card it belongs on.
 *
 * The node that forwarded the report is authenticated (`routes/gateway.ts`);
 * nothing in the report is. So the station is found from the authenticated
 * node and the Matrix id the agent speaks as — `stations.matrix_id`, which is
 * what the node itself reports for a harness station — and the reader is that
 * station's owner's Matrix id, found the same way the bridge finds a room's
 * reader (`matrix-as/index.ts` `readerForRoom`). The report's own `reader`
 * is only compared against this.
 *
 * The room is not proven to be the agent's — the hub is not in a harness
 * agent's rooms and holds no credential to ask — but a room the hub knows to
 * be ANOTHER station's is refused, so an agent cannot put itself on the card
 * as working in someone else's room. What it can do at worst is show its own
 * owner its own name against a room id of its choosing.
 */

import { and, asc, eq } from "drizzle-orm";

import { db } from "../../../db/drizzle";
import { principalIdentities } from "../../../db/schema/identities";
import { matrixRooms } from "../../../db/schema/matrix";
import { stations } from "../../../db/schema/stations";
import { principalForUser } from "../../principals";
import type { ReportingAgent } from "./agent-reports";

export async function reportingAgentFor(nodeId: string, agent: string, roomId: string): Promise<ReportingAgent | null> {
  const [station] = await db
    .select({
      id: stations.id,
      userId: stations.userId,
      principalId: stations.principalId,
      displayName: stations.displayName,
    })
    .from(stations)
    .where(and(eq(stations.nodeId, nodeId), eq(stations.matrixId, agent)))
    .orderBy(asc(stations.id))
    .limit(1);
  if (!station) return null;

  const [room] = await db
    .select({ stationId: matrixRooms.stationId, principalId: matrixRooms.principalId })
    .from(matrixRooms)
    .where(eq(matrixRooms.roomId, roomId));
  if (room) {
    const ours =
      room.stationId === station.id || (room.principalId !== null && room.principalId === station.principalId);
    if (!ours) return null;
  }

  const owner = await principalForUser(station.userId);
  if (!owner) return null;
  const [identity] = await db
    .select({ externalId: principalIdentities.externalId })
    .from(principalIdentities)
    .where(and(eq(principalIdentities.principalId, owner.id), eq(principalIdentities.system, "matrix")))
    .limit(1);
  if (!identity) return null;

  return { reader: identity.externalId, name: station.displayName.trim() || localpart(agent) };
}

/** `@agent_lyra:hs` → `lyra`: a name of last resort. */
function localpart(mxid: string): string {
  const local = mxid.replace(/^@/, "").split(":")[0] ?? mxid;
  return local.replace(/^agent_/, "") || mxid;
}
