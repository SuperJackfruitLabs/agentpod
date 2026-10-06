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
 * **The hub signs nothing.** Once the node and the station binding are proven, the organization
 * plane is asked, with the hub's own `svc_` credential, for the occupying agent's token
 * (`POST /api/token/agent`, contract §3.4). The plane refuses a suspended principal (423 → 403
 * here). Its `act.sub` names the hub's service principal, not the node (gap G5), so the hub logs
 * `{ nodeId, stationId, principal, jti }` for every exchange: the node stays attributable in the
 * hub's own record.
 *
 * Mounted under `/api`, not `/public`: `Bearer` already passes the CSRF
 * middleware (unlike the HMAC-signed `superpipeline-push` receiver, which needs
 * `/public` because a signed body is not a bearer credential), so nothing
 * here needs the exemption.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { verifyNodeCredential } from "../services/enrollment";
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
  plane?: () => OrgPlaneConfig;
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
  );
}

export const stationTokenRoutes = createStationTokenRoutes();
