/**
 * A node redeems a human's authorization for a station's Matrix credential.
 *
 * `matrix-credential.ts` (Task 1) is the mint side: a human authorises one
 * station, which produces a short-lived, single-use token. This is the
 * redeem side, and it is `station-token.ts`'s sibling — same shape, same
 * refusals, because the problem is the same one: a node holds no long-lived
 * credential of the station's own, so it exchanges the one it DOES hold
 * (`<nodeId>:<nodeSecret>`, proven once at enrollment) for what the station
 * needs. There, that exchange produces a JWT naming the occupant; here, it
 * produces a Matrix access token for the occupant's own address.
 *
 * **The credential and the node-id-matches-path check are copied from
 * `station-token.ts`, not re-derived** — same `Bearer <nodeId>:<nodeSecret>`
 * parsing, same rule that a credential which verifies for a different node
 * than the path names is refused exactly like a wrong secret.
 *
 * **A station that does not exist and one hosted by another node are
 * refused identically (403).** `station-token.ts` explains why: telling
 * them apart would let a node probe another node's station ids by reading
 * 403 apart from 404.
 *
 * **Register-or-rotate is copied from `station-matrix.ts:176-204`, not
 * re-derived.** That file's comment records why it asks the homeserver
 * rather than branching on `matrixIdentityMode`: an earlier version branched
 * on the mode column, which reads as "does this identity exist" and is not
 * — every station the bridge has ever adopted already has one, just not its
 * own credentials, so branching on mode sent every station on a real
 * deployment down the register path where it failed `M_USER_IN_USE`.
 *
 * **The hub never logs the access token it just minted.** The audit line
 * below records the device id, exactly as `station-matrix.ts` does, and
 * deliberately not the credential.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { verifyNodeCredential } from "../services/enrollment";
import { principalHandle } from "../services/principals";
import { redeemCredentialAuthorization } from "../services/matrix-credential";
import { bridgeLocalpart } from "../services/matrix-as/names";
import { isMatrixUserInUse } from "../services/matrix-as/client";
import type { IssuedCredentials } from "./station-matrix";

export interface StationMatrixCredentialDeps {
  credentials: {
    /** Register the identity and return its first credentials. */
    register(localpart: string): Promise<IssuedCredentials>;
    /**
     * Replace the credentials of an identity that already exists.
     *
     * Optional for the same reason `station-matrix.ts` leaves it optional:
     * it needs the homeserver's admin account, which a deployment may not
     * have configured.
     */
    rotate?: (localpart: string) => Promise<IssuedCredentials>;
  };
  /** Injected so the tests can prove a token never reaches it. */
  log?: (line: string) => void;
}

export function createStationMatrixCredentialRoutes(deps: StationMatrixCredentialDeps) {
  const say = deps.log ?? ((line: string) => console.log(line));

  return new Hono().post(
    "/nodes/:nodeId/stations/:stationId/matrix-credential",
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const stationId = c.req.param("stationId");

      // Same scheme as station-token.ts — Authorization: Bearer
      // <nodeId>:<nodeSecret>, and a credential that verifies for a
      // different node than the path names is refused exactly like a wrong
      // secret.
      const auth = c.req.header("Authorization") ?? "";
      const bearer = auth.replace(/^Bearer\s+/, "");
      const idx = bearer.indexOf(":");
      const credNodeId = idx !== -1 ? bearer.slice(0, idx) : "";
      const nodeSecret = idx !== -1 ? bearer.slice(idx + 1) : "";

      if (
        !credNodeId ||
        !nodeSecret ||
        credNodeId !== nodeId ||
        !(await verifyNodeCredential(credNodeId, nodeSecret))
      ) {
        return c.json({ error: "invalid node credential" }, 401);
      }

      const [station] = await db
        .select()
        .from(stations)
        .where(eq(stations.id, stationId));

      // The node proves who IT is, not what it may reach — see
      // station-token.ts for why an unknown station and one hosted by
      // another node are refused identically rather than as 404 vs 403.
      if (!station || station.nodeId !== nodeId) {
        return c.json({ error: "station not hosted by this node" }, 403);
      }

      const handle = station.principalId ? await principalHandle(station.principalId) : null;
      if (!handle) {
        // Not an error condition — the ordinary state of a station nobody
        // has put an agent on. Said distinctly (409), as station-token.ts
        // does for the same fact.
        return c.json({ error: "station has no occupying principal" }, 409);
      }

      const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
      const token = typeof body.authorization === "string" ? body.authorization : "";

      // Unknown, expired, already redeemed, or minted for a different
      // station — redeemCredentialAuthorization collapses all four into
      // `false` and this endpoint answers them identically, for the same
      // reason the station check above collapses "does not exist" and
      // "hosted elsewhere": distinguishing them would tell a caller which
      // guess to try next.
      if (!token || !(await redeemCredentialAuthorization(stationId, token))) {
        return c.json({ error: "no authorization to redeem" }, 403);
      }

      const localpart = bridgeLocalpart(handle);

      // Register, and rotate if the identity turns out to already exist —
      // copied from station-matrix.ts:176-204, which asks the homeserver
      // rather than branching on matrixIdentityMode. See that file's
      // comment for why the branch was wrong.
      let issued: IssuedCredentials;
      try {
        issued = await deps.credentials.register(localpart);
      } catch (e) {
        if (!isMatrixUserInUse(e)) throw e;
        if (!deps.credentials.rotate) {
          return c.json(
            {
              error:
                "This identity already exists, and rotating its credentials needs a " +
                "capability this hub is not configured with.",
            },
            409
          );
        }
        issued = await deps.credentials.rotate(localpart);
      }

      await db
        .update(stations)
        .set({ matrixIdentityMode: "harness" })
        .where(eq(stations.id, station.id));

      // Audited, and never with the token in it: this line exists so the
      // act is visible, not so the credential is recoverable from a log.
      say(
        `[station-matrix-credential] issued Matrix credentials for station ${station.id} ` +
          `(node ${nodeId}, device ${issued.deviceId})`
      );

      return c.json({
        userId: issued.userId,
        accessToken: issued.accessToken,
        deviceId: issued.deviceId,
      });
    }
  );
}
