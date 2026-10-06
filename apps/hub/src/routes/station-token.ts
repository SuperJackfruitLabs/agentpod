/**
 * A node exchanges its long-term `<nodeId>:<nodeSecret>` credential for a
 * short-lived token naming the principal occupying one of its stations.
 *
 * This is the endpoint that lets an agent hold no long-lived credential of
 * its own — the node already proved itself once, at enrollment, and this is
 * that proof spent again on a station's behalf
 * (`charter → decisions/2026-08-30-an-agent-is-a-principal.md`). It is also
 * the most sensitive thing in this slice: a token minted for the wrong
 * subject makes every action the agent takes attribute to the wrong
 * principal while looking exactly like it worked. Every refusal here fails
 * closed, and each is distinct so an operator reading a 4xx knows which.
 *
 * **The credential.** A station holds no secret of its own — `stations.ts`
 * carries `matrixId`, `bridgeMatrixId`, `principalId` and nothing that could
 * authenticate a request. The node's `<nodeId>:<nodeSecret>` is what exists,
 * so the node exchanges on the station's behalf, following the exact scheme
 * `nodes.ts`'s credential-check uses — parsed the same way, verified with
 * the same `verifyNodeCredential`.
 *
 * **Claims come from `buildTokenPayload` and nowhere else.** Hand-assembling
 * a payload here would be exactly how an agent ends up carrying authority
 * its grant does not give. `buildTokenPayload` also refuses to mint for a
 * suspended principal — that refusal is let through rather than
 * re-implemented, only translated from the 500 it throws as into the 403 it
 * means.
 *
 * **The token also carries `act: { sub: nodeId }`.** `sub` is the agent —
 * this is its own token, not an assertion of someone else — but the agent
 * did not present a credential; the node did, on its behalf. Recording that
 * distinctly is what lets an auditor tell "the agent acted" apart from
 * "node N minted a token for the agent", which is the fact that scopes a
 * compromised node's blast radius to that node
 * (`auth/service-signing.ts`:19-25).
 *
 * Mounted under `/api`, not `/public`: `Bearer` already passes the CSRF
 * middleware (unlike the HMAC-signed `superpipeline-push` receiver, which needs
 * `/public` because a signed body is not a bearer credential), so nothing
 * here needs the exemption.
 *
 * **Under the org plane** (`ORG_PLANE_*` set) the hub signs nothing. Node authentication and the
 * station binding run exactly as below; only then is the plane asked, with the hub's own `svc_`
 * credential, for the occupying agent's token (`POST /api/token/agent`, contract §3.4). The
 * response shape is unchanged, so no node release follows. The plane's `act.sub` names the hub's
 * service principal, not the node (gap G5), so the hub logs `{ nodeId, stationId, principal, jti }`
 * for every exchange: the node stays attributable in the hub's own record.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { verifyNodeCredential } from "../services/enrollment";
import { buildTokenPayload, TOKEN_TTL } from "../auth/jwt-claims";
import { signServiceToken } from "../auth/service-signing";
import { HUB_AUDIENCE, STATION_TOKEN_AUDIENCES } from "../config";
import { orgPlane, type OrgPlaneConfig } from "../auth/org-plane/config";
import { orgPlaneClient, OrgPlaneError, type OrgPlaneClient } from "../services/org-plane/client";
import { createLogger } from "../utils/logger";

const log = createLogger("station-token");

/**
 * The plane's audience for this hub first, then any configured work planes (contract §3.4: a
 * string or an array). `workPlanes` defaults to `WORK_PLANE_AUDIENCES` — `STATION_TOKEN_AUDIENCES`
 * without its first entry, the hub's legacy audience, which under the plane is the plane's.
 */
export function stationAudiences(plane: OrgPlaneConfig, workPlanes: string[] = STATION_TOKEN_AUDIENCES.slice(1)): string[] {
  return [plane.audience, ...new Set(workPlanes.filter((a) => a !== plane.audience && a !== HUB_AUDIENCE))];
}

/** The plane's refusal (contract §3.4) → what the node is told. Each is distinct. */
const PLANE_REFUSALS: Record<number, [403 | 409 | 502 | 503, string]> = {
  423: [403, "principal suspended"],
  404: [409, "station's principal is unknown to the org plane"],
  403: [502, "the org plane refused this hub"],
  0: [503, "the org plane is unreachable"],
};

export interface StationTokenDeps {
  plane?: () => OrgPlaneConfig | null;
  client?: () => Pick<OrgPlaneClient, "agentToken">;
  /** Where the plane's token may be spent; defaults to `stationAudiences(plane)`. */
  audiences?: (plane: OrgPlaneConfig) => string[];
}

export function createStationTokenRoutes(deps: StationTokenDeps = {}) {
  return new Hono().post(
    "/nodes/:nodeId/stations/:stationId/token",
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const stationId = c.req.param("stationId");

      // Same scheme as nodes.ts:249-258 — Authorization: Bearer
      // <nodeId>:<nodeSecret>. The credential must both verify AND name the
      // node the URL claims to be: a credential that verifies for a different
      // node is not this node's request, whatever the path says, so a
      // mismatch here fails the same way a wrong secret does.
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

      // The node proves who IT is, not what it may reach. A station that does
      // not exist and a station hosted by a different node are
      // indistinguishable to this credential and refused identically —
      // otherwise this endpoint would let one node probe another's station
      // ids by reading 403 apart from 404. Without this check any node could
      // mint a token for any agent in the fleet just by naming its station.
      if (!station || station.nodeId !== nodeId) {
        return c.json({ error: "station not hosted by this node" }, 403);
      }

      // Not an error condition — the ordinary state of a station nobody has
      // put an agent on. Said distinctly (409, not 403/404) so an operator
      // reading it does not mistake an unassigned station for a fault.
      if (!station.principalId) {
        return c.json({ error: "station has no occupying principal" }, 409);
      }

      // Only now — node proven, station bound, principal found — may the plane be asked.
      const plane = (deps.plane ?? orgPlane)();
      if (plane) {
        const audiences = (deps.audiences ?? ((p: OrgPlaneConfig) => stationAudiences(p)))(plane);
        try {
          const { accessToken, expiresIn } = await (deps.client ?? orgPlaneClient)().agentToken(
            station.principalId,
            audiences.length === 1 ? audiences[0]! : audiences,
          );
          // Gap G5: the plane's act.sub names the hub, not the node. Keep the node in the hub's record.
          let jti: unknown = null;
          try {
            jti = decodeJwt(accessToken).jti ?? null;
          } catch {
            jti = null;
          }
          log.info("station token issued by the org plane", {
            nodeId,
            stationId,
            principal: station.principalId,
            jti,
          });
          return c.json({ token: accessToken, expiresIn });
        } catch (e) {
          if (e instanceof OrgPlaneError) {
            const [status, message] = PLANE_REFUSALS[e.status] ?? [502, "the org plane refused this hub"];
            log.warn("org plane refused a station token", {
              nodeId,
              stationId,
              principal: station.principalId,
              status: e.status,
              code: e.code,
            });
            return c.json({ error: message }, status);
          }
          throw e;
        }
      }

      let payload;
      try {
        payload = await buildTokenPayload({ principalId: station.principalId });
      } catch (e) {
        // buildTokenPayload's own refusal for a suspended principal — let
        // through rather than re-implemented, translated from the 500 a
        // thrown Error becomes by default into the 403 it actually means.
        // Anything else here would be a bug (a station's principalId is a
        // live foreign key), so it is left to propagate as a 500.
        if (/suspended/.test((e as Error).message)) {
          return c.json({ error: "principal suspended" }, 403);
        }
        throw e;
      }

      const token = await signServiceToken({
        payload,
        subject: station.principalId,
        ttl: TOKEN_TTL,
        // Delegation that cannot be seen in the record is impersonation with
        // better manners (service-signing.ts:19-25). sub names the agent, but
        // the agent is not the one presenting a credential here — the node is,
        // on its behalf — so act.sub names the node. On a compromised node
        // this is the fact that scopes the blast radius to that node instead
        // of reading as "the agent acted" with nothing to tell the two apart.
        extraClaims: { act: { sub: nodeId } },
        /**
         * Where this token may be spent. Passing nothing let `signServiceToken` fall back to the
         * hub's own URL, so every station token was refused by every other plane — superpipeline
         * demands its own `APP_URL` in `aud` and got the hub's instead. Nothing consumed this route
         * yet, which is the only reason that never showed up as a bug report.
         *
         * From CONFIGURATION, never from the request. A station token is minted against an enrollment
         * secret, so a node able to name its own audiences could mint credentials for any plane it
         * liked — precisely the blast radius `act: { sub: nodeId }` above exists to bound. The device
         * exchange may take a `?client=` because a client is a registered entry an operator wrote
         * down; there is no client here, and there should not be.
         */
        audiences: STATION_TOKEN_AUDIENCES,
      });

      // Read back from the signed token rather than a second constant, so
      // `expiresIn` can never drift from what the token itself says.
      const { iat, exp } = decodeJwt(token);
      const expiresIn = typeof iat === "number" && typeof exp === "number" ? exp - iat : undefined;

      return c.json({ token, expiresIn });
    }
  );
}

export const stationTokenRoutes = createStationTokenRoutes();
