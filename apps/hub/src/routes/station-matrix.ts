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
import { bridgeUserId, bridgeLocalpart } from "../services/matrix-as/names";
import { roomAliasForStation } from "../services/matrix-as/station-room";
import { isMatrixUserInUse } from "../services/matrix-as/client";
import { principalHandle } from "../services/principals";
import { mintCredentialAuthorization, UnknownStationError } from "../services/matrix-credential";
import * as broker from "../services/broker";
import type { AuthUser } from "../auth/middleware";

/**
 * Harnesses whose node-agent can write a Matrix credential into a profile.
 *
 * The writers themselves live in the Go node-agent
 * (`apps/node-agent/internal/descriptor/` — Task 5 of this slice adds the
 * registry there) and the hub cannot see into that binary, so this is the
 * hub's own copy of "which harnesses can this ever work for" — kept in sync
 * by hand until a harness's adapter ships alongside it.
 *
 * Slice 1 ships the Hermes adapter only (all 14 harness-mode stations on the
 * fleet today are Hermes); slice 2 adds `openclaw`, `opencode`, `pi`,
 * `codex`, `claudecode` here, one at a time, alongside each adapter.
 */
const HARNESSES_WITH_PROFILE_WRITER: ReadonlySet<string> = new Set(["hermes"]);

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
        principalId: stations.principalId,
        harness: stations.harness,
      })
      .from(stations)
      .innerJoin(nodes, eq(nodes.id, stations.nodeId))
      .where(and(eq(stations.id, stationId), eq(stations.userId, userId)));
    return row ?? null;
  }

  /**
   * The handle of the agent occupying a station, or null.
   *
   * A station with no occupying principal has no handle and therefore no
   * agent mxid — never invented from `(nodeName, stationKey)`, which is
   * exactly the station-derived identity this file stopped minting. Every
   * caller treats null as a 409, failing visibly rather than building an
   * address for nobody.
   */
  async function occupyingHandle(station: { principalId: string | null }): Promise<string | null> {
    return station.principalId ? principalHandle(station.principalId) : null;
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

      const handle = await occupyingHandle(station);
      if (!handle) {
        return c.json(
          {
            error:
              "This station has no occupying agent, so it has no Matrix identity of its own.",
          },
          409
        );
      }

      // The address the room this endpoint just provisioned is ACTUALLY
      // reachable at, read through the one resolver for that question — not
      // `bridgeAlias(nodeName, stationKey)` re-derived here, which is what
      // this returned until fix round 5. An occupied station's room is
      // addressed by its occupant's handle, and this endpoint 409s below
      // unless the station HAS an occupant, so the station-derived form was
      // wrong for every station it can answer for: the AS route 200s on it
      // through the legacy fallback and then creates nothing (the station
      // already has a room), and the caller is left with a directory lookup
      // that fails.
      return c.json({
        mxid: bridgeUserId(handle, deps.domain),
        alias: await roomAliasForStation(station.id, deps.domain),
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

      const handle = await occupyingHandle(station);
      if (!handle) {
        return c.json(
          {
            error:
              "This station has no occupying agent, so it has no Matrix identity to issue credentials for.",
          },
          409
        );
      }

      const localpart = bridgeLocalpart(handle);

      // Register, and rotate if the identity turns out to already exist.
      //
      // An earlier version branched on `station.mode === "harness"`, which reads
      // as "does this identity exist" and is not. The bridge provisions an
      // identity for every station it adopts, so a station in `bridge` mode has
      // one too — it simply does not hold its own credentials. Every station on
      // a real deployment was therefore sent down the `register` path and every
      // one of them failed `M_USER_IN_USE`, which reached the operator as a 500.
      //
      // The homeserver is the authority on whether a user exists, so this asks
      // it rather than inferring from a column that means something else.
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
    })

    /**
     * POST /api/stations/:id/matrix/authorize-move
     *
     * The operator's half of moving a harness-mode station onto its own,
     * principal-derived identity (`charter` →
     * decisions/2026-08-15-granting-reach-is-changing-an-agent.md; design
     * `docs/superpowers/specs/2026-09-01-uniform-matrix-identity-design.md`
     * §2). This mints a single-use, short-lived, station-scoped authorization
     * and signals the station's node to redeem it (`matrix.adopt`, over the
     * existing broker). It does not pre-join the new identity to the room or
     * handle convergence; those belong to the ordered move in a later task,
     * deliberately not stubbed here.
     *
     * There is no token: the record minted is station-scoped, and the node
     * redeeming it is already authenticated by its own long-term credential
     * (`routes/station-matrix-credential.ts`). The response below carries
     * only `expiresAt`.
     *
     * The broker signal is sent but never awaited into the response: a node
     * that is offline, slow, or never answers must not turn a successful
     * authorization into a failed HTTP call — the record above is already
     * committed and can be signalled again (including by calling this route
     * again). A failed signal is only logged.
     */
    .post("/stations/:id/matrix/authorize-move", async (c) => {
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
              "Authorizing this station to redeem its own Matrix credential is granting it " +
              "reach, which your grant does not permit for this agent.",
          },
          403
        );
      }

      const handle = await occupyingHandle(station);
      if (!handle) {
        return c.json(
          {
            error:
              "This station has no occupying agent, so there is nothing to move to its own identity.",
          },
          409
        );
      }

      if (!HARNESSES_WITH_PROFILE_WRITER.has(station.harness)) {
        return c.json(
          {
            error: `${station.harness} has no Matrix profile writer yet, so this station cannot move to its own identity.`,
          },
          409
        );
      }

      let authorization: { expiresAt: Date };
      try {
        authorization = await mintCredentialAuthorization(station.id);
      } catch (e) {
        if (!(e instanceof UnknownStationError)) throw e;
        return c.json({ error: "Not Found" }, 404);
      }

      // Signal the node now that the authorization exists. Deliberately not
      // awaited into the response — see this route's own comment above for
      // why a failed or slow signal must not turn a successful authorization
      // into a failed HTTP call. `broker.request` never rejects (its own
      // contract: offline resolves `{ok:false, error:"node offline"}`), so
      // this needs no catch, only a look at the result once it settles.
      //
      // Both `key` and `stationId` travel — the node's profile-directory
      // lookup needs the station KEY, but the hub's redemption endpoint is
      // keyed by the station's database ID, and neither can stand in for the
      // other (Defect 2). Both are non-secret, so this stays within the
      // broker's own constraint: the credential itself never rides along.
      void broker
        .request(station.nodeId, "matrix.adopt", { key: station.stationKey, stationId: station.id })
        .then((result) => {
          if (!result.ok) {
            say(
              `[station-matrix] authorised ${station.id} but could not signal node ` +
                `${station.nodeId} to adopt it (${result.error ?? "unknown error"}) — the ` +
                `authorization stands and can be signalled again`
            );
          }
        });

      return c.json({ expiresAt: authorization.expiresAt });
    });
}
