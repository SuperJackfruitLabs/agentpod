/**
 * A station's Matrix identity, over the hub's API.
 *
 * This is what replaces the homeserver admin token that lives in a file on
 * molt-bot today. That credential can create, deactivate or take over **any**
 * account on the homeserver, including a human's, and it sits on a node so a
 * shell script can reach it.
 *
 * Two paths, and the difference between them is the point:
 *
 * - **identity** needs no privilege at all. An Application Service may register
 *   users inside its own namespace, so this is the appservice acting as itself.
 * - **credentials** hands an agent its own access token, which is the definition
 *   of granting it reach (`charter` →
 *   decisions/2026-08-15-granting-reach-is-changing-an-agent.md). It is gated on
 *   `mayGrantReach` and on the station being in the caller's dispatch scope.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { nodes } from "../db/schema/nodes";
import { requireIssueCredentials } from "../services/grant-reach";
import { isGrantReachDenied } from "../services/control-pair";
import { bridgeUserId, bridgeAlias, bridgeLocalpart } from "../services/matrix-as/names";
import type { AuthUser } from "../auth/middleware";

export interface IssuedCredentials {
  userId: string;
  accessToken: string;
  deviceId: string;
}

export interface StationMatrixDeps {
  domain: string;
  provisionStation(stationId: string): Promise<void>;
  credentials: {
    /** Register the identity and return its first credentials. */
    register(localpart: string): Promise<IssuedCredentials>;
    /**
     * Replace the credentials of an identity that already exists.
     *
     * Optional because it needs the homeserver's admin account, which a
     * deployment may not have configured. Absent means "cannot be done here",
     * which is answered plainly rather than as a 500.
     */
    rotate?: (localpart: string) => Promise<IssuedCredentials>;
  };
  /** Injected so the tests can prove a token never reaches it. */
  log?: (line: string) => void;
}

export function createStationMatrixRoutes(deps: StationMatrixDeps) {
  const say = deps.log ?? ((line: string) => console.log(line));

  /** The station, if it belongs to this principal. */
  async function ownedStation(userId: string, stationId: string) {
    const [row] = await db
      .select({
        id: stations.id,
        nodeId: stations.nodeId,
        nodeName: nodes.name,
        stationKey: stations.stationKey,
        mode: stations.matrixIdentityMode,
      })
      .from(stations)
      .innerJoin(nodes, eq(nodes.id, stations.nodeId))
      .where(and(eq(stations.id, stationId), eq(stations.userId, userId)));
    return row ?? null;
  }

  return new Hono()
    /**
     * POST /api/stations/:id/matrix/identity
     *
     * Give this station a Matrix identity and a room. Safe to call repeatedly —
     * it is how a dynamically created agent on ANY harness gets one, without
     * that harness learning to talk to a homeserver.
     */
    .post("/stations/:id/matrix/identity", async (c) => {
      const user = c.get("user") as AuthUser;
      const station = await ownedStation(user.id, c.req.param("id"));
      if (!station) return c.json({ error: "Not Found" }, 404);

      await deps.provisionStation(station.id);

      return c.json({
        mxid: bridgeUserId(station.nodeName, station.stationKey, deps.domain),
        alias: bridgeAlias(station.nodeName, station.stationKey, deps.domain),
        mode: station.mode,
      });
    })

    /**
     * POST /api/stations/:id/matrix/credentials
     *
     * Hand this station its own access token, so its harness can run a Matrix
     * client instead of the bridge speaking for it. Flips the station to
     * `harness` mode in the same write — the bridge stops answering there the
     * moment somebody else can, because two answerers on one address is the
     * failure the mode exists to prevent.
     */
    .post("/stations/:id/matrix/credentials", async (c) => {
      const user = c.get("user") as AuthUser;
      const station = await ownedStation(user.id, c.req.param("id"));
      if (!station) return c.json({ error: "Not Found" }, 404);

      try {
        await requireIssueCredentials(user.id, {
          nodeId: station.nodeId,
          stationKey: station.stationKey,
        });
      } catch (e) {
        if (!isGrantReachDenied(e)) throw e;
        return c.json(
          {
            error:
              "Issuing an agent its own credentials is granting it reach, which your " +
              "grant does not permit for this agent.",
          },
          403
        );
      }

      const localpart = bridgeLocalpart(station.nodeName, station.stationKey);

      // An identity provisioned earlier already exists, so "already registered"
      // is the normal case here rather than an error — but replacing its
      // credentials needs the homeserver's admin account.
      const alreadyHasIdentity = station.mode === "harness";
      let issued: IssuedCredentials;

      if (alreadyHasIdentity) {
        if (!deps.credentials.rotate) {
          return c.json(
            {
              error:
                "This identity already exists, and rotating its credentials needs the " +
                "homeserver admin account, which this hub is not configured with.",
            },
            409
          );
        }
        issued = await deps.credentials.rotate(localpart);
      } else {
        issued = await deps.credentials.register(localpart);
      }

      await db
        .update(stations)
        .set({ matrixIdentityMode: "harness" })
        .where(eq(stations.id, station.id));

      // Audited, and never with the token in it: this line exists so the act is
      // visible, not so the credential is recoverable from a log.
      say(
        `[station-matrix] issued Matrix credentials for ${station.nodeName}/${station.stationKey} ` +
          `to principal ${user.id} (device ${issued.deviceId})`
      );

      return c.json({
        mxid: issued.userId,
        accessToken: issued.accessToken,
        deviceId: issued.deviceId,
        mode: "harness",
      });
    });
}
