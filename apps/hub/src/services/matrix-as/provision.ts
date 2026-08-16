/**
 * Giving every station a Matrix identity and somewhere to be talked to.
 *
 * Runs when a station is adopted and again at boot, so it has to be idempotent
 * in the way that matters: not "does not crash on a second run", but "a second
 * run changes nothing an operator would notice".
 *
 * What it will not do is register over a station that answers for itself. A
 * `harness`-mode station has its own account and its own client; minting a
 * second identity for it would produce two answerers on one address, which is
 * the failure the mode exists to prevent.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { nodes } from "../../db/schema/nodes";
import { matrixRooms } from "../../db/schema/matrix";
import { principalIdentities } from "../../db/schema/identities";
import { bridgeUserId, bridgeAlias, bridgeLocalpart } from "./names";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-provision");

export interface ProvisionDeps {
  domain: string;
  client: {
    ensureUser(localpart: string, displayName: string): Promise<void>;
    ensureRoom(
      alias: string,
      opts: { creator: string; name: string; topic: string }
    ): Promise<string | null>;
    invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
  };
}

/** The station, its node's name, and whether a room already exists for it. */
async function context(stationId: string) {
  const [row] = await db
    .select({
      stationId: stations.id,
      tenantId: stations.tenantId,
      userId: stations.userId,
      stationKey: stations.stationKey,
      harness: stations.harness,
      displayName: stations.displayName,
      identityMode: stations.matrixIdentityMode,
      harnessMxid: stations.matrixId,
      nodeName: nodes.name,
      roomId: matrixRooms.roomId,
    })
    .from(stations)
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .leftJoin(matrixRooms, eq(matrixRooms.stationId, stations.id))
    .where(eq(stations.id, stationId));
  return row ?? null;
}

/** The owner's Matrix id, so the room is not a locked door. */
async function ownerMxid(principalId: string): Promise<string | null> {
  const [row] = await db
    .select({ externalId: principalIdentities.externalId })
    .from(principalIdentities)
    .where(
      and(
        eq(principalIdentities.principalId, principalId),
        eq(principalIdentities.system, "matrix")
      )
    );
  return row?.externalId ?? null;
}

export async function provisionStation(stationId: string, deps: ProvisionDeps): Promise<void> {
  const s = await context(stationId);
  if (!s) return;

  const bridged = s.identityMode === "bridge";

  // Whoever answers in this room is who creates it. For a bridge-mode station
  // that is the identity we mint; for a harness-mode one it is the account the
  // harness already holds, and if it has none there is nobody to create the
  // room as — inventing one would be the bridge answering for a station that is
  // supposed to answer for itself.
  const speaker = bridged
    ? bridgeUserId(s.nodeName, s.stationKey, deps.domain)
    : s.harnessMxid;
  if (!speaker) {
    log.warn("station answers for itself but has no Matrix identity; nothing to provision", {
      stationId,
      stationKey: s.stationKey,
    });
    return;
  }

  // A name a person can read. The mxid is derived and unlovely; this is what a
  // member list shows, and it is set on every run so a rename lands.
  const displayName = `${s.displayName} (${s.harness} @ ${s.nodeName})`;

  if (bridged) {
    await deps.client.ensureUser(bridgeLocalpart(s.nodeName, s.stationKey), displayName);
  }

  // The room is created once. A second one for the same station would split its
  // conversation in two, with each half unaware of the other.
  if (!s.roomId) {
    const alias = bridgeAlias(s.nodeName, s.stationKey, deps.domain);
    const roomId = await deps.client.ensureRoom(alias, {
      creator: speaker,
      name: s.displayName,
      topic: `${s.harness} on ${s.nodeName} — ${s.stationKey}`,
    });

    if (roomId) {
      await db
        .insert(matrixRooms)
        .values({ roomId, tenantId: s.tenantId, stationId: s.stationId, alias })
        .onConflictDoNothing();

      const invitee = await ownerMxid(s.userId);
      // Only on creation: re-inviting somebody into a room they are already in
      // is an error on some homeservers and noise on all of them.
      if (invitee) await deps.client.invite(speaker, roomId, invitee);
    }
  }

  if (bridged) {
    await db
      .update(stations)
      .set({ bridgeMatrixId: speaker })
      .where(eq(stations.id, s.stationId));
  }
}

/**
 * Provision everything that has not been.
 *
 * Runs at boot. One station's failure must not leave the other 31 without
 * rooms, and the count of failures is returned rather than swallowed so
 * "provisioned 31 of 32" is something an operator can see.
 */
export async function provisionAll(
  deps: ProvisionDeps
): Promise<{ provisioned: number; failed: number }> {
  const rows = await db.select({ id: stations.id }).from(stations);

  let provisioned = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await provisionStation(row.id, deps);
      provisioned++;
    } catch (err) {
      failed++;
      log.error("could not provision a station's Matrix identity", {
        stationId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("matrix provisioning complete", { provisioned, failed });
  return { provisioned, failed };
}
