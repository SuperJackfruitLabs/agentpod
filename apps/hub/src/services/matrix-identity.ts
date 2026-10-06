/**
 * Given a Matrix id, who is that?
 *
 * The question an Application Service bridge asks on every inbound event, and
 * the last piece of Phase 2 in docs/superpowers/plans/2026-08-15-organization-layer.md.
 *
 * Both halves exist now and they live in different tables, for good reasons that
 * this function has to reconcile:
 *
 *   - **agents** carry their mxid on `stations.matrix_id`, read off the host by
 *     the node agent from a harness profile. AgentPod owns that fact because it
 *     owns the station.
 *   - **people** are mapped at the organization plane, which owns principals and
 *     their identities (`GET /api/identities/matrix/:mxid`, contract §3.5).
 *
 * The answer distinguishes them rather than merely saying "known", because
 * everything downstream treats them differently: a human's approval must carry
 * its sender or superpipeline's separation-of-duties check is void
 * (charter decisions/2026-08-14-approvals-cross-planes-as-events.md), while an
 * agent's message is work output. Collapsing the two here would throw that
 * distinction away at the one point where keeping it is free.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { principalDirectory } from "./org-plane/directory";

export type MatrixIdentity =
  | { kind: "principal"; principalId: string }
  | { kind: "station"; stationId: string; nodeId: string; harness: string }
  /**
   * The same mxid is claimed by a station AND a principal.
   *
   * Nothing prevents this: the two facts live in different tables with no
   * constraint spanning them, and they arrive from different places — one read
   * off a host, one written by an operator. Silently preferring either would
   * attribute a human's approval to an agent, or an agent's output to a human.
   * So the ambiguity is reported and the caller fails closed.
   */
  | { kind: "ambiguous"; stationId: string; principalId: string }
  | null;

/** What a person is told when the org plane cannot say who they are (design §5.7). */
export const IDENTITY_UNAVAILABLE_TEXT =
  "I cannot check who you are right now — the account service is unreachable. Nothing has changed; try again in a minute.";

/** `@localpart:domain`, checked only well enough to skip an obviously pointless query. */
const MXID = /^@[^:]+:.+$/;

/**
 * The person half is the plane's `GET /api/identities/matrix/:mxid` — the one plane call design
 * §5.7 allows on an authorization path — through the directory's 60 s cache with last-good. A plane
 * that cannot be reached with nothing cached throws `OrgPlaneError` out of here: "down" must never
 * read as "unlinked". The station half stays local; stations are the hub's.
 */
export async function resolveMatrixId(mxid: string): Promise<MatrixIdentity> {
  if (!mxid || !MXID.test(mxid)) return null;

  const principalLookup: Promise<Array<{ principalId: string }>> = principalDirectory()
    .identity("matrix", mxid)
    .then((r) => (r ? [{ principalId: r.principalId }] : []));

  const [stationRows, principalRows] = await Promise.all([
    db
      .select({
        id: stations.id,
        nodeId: stations.nodeId,
        harness: stations.harness,
      })
      .from(stations)
      .where(eq(stations.matrixId, mxid))
      .limit(2),
    principalLookup,
  ]);

  // Asked of the plane as `system = 'matrix'`, deliberately. An external id is
  // opaque per system, so a superpipeline or org-plane id that happened to be shaped
  // like an mxid must not answer "who is this Matrix sender" — it names the same
  // person in a different namespace, which is not the same claim.
  const station = stationRows[0];
  const principal = principalRows[0];

  if (station && principal) {
    return { kind: "ambiguous", stationId: station.id, principalId: principal.principalId };
  }

  if (station) {
    return {
      kind: "station",
      stationId: station.id,
      nodeId: station.nodeId,
      harness: station.harness,
    };
  }

  if (principal) {
    return { kind: "principal", principalId: principal.principalId };
  }

  // Most Matrix ids in a room belong to neither — other people's accounts, bots,
  // the homeserver's own. Unknown is an ordinary answer, so a bridge can ignore
  // an event instead of failing on it.
  return null;
}
