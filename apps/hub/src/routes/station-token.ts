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
 * Mounted under `/api`, not `/public`: `Bearer` already passes the CSRF
 * middleware (unlike the HMAC-signed `kaambaan-push` receiver, which needs
 * `/public` because a signed body is not a bearer credential), so nothing
 * here needs the exemption.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { verifyNodeCredential } from "../services/enrollment";
import { buildTokenPayload, TOKEN_TTL } from "../auth/jwt-claims";
import { signServiceToken } from "../auth/service-signing";

export const stationTokenRoutes = new Hono().post(
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
    });

    // Read back from the signed token rather than a second constant, so
    // `expiresIn` can never drift from what the token itself says.
    const { iat, exp } = decodeJwt(token);
    const expiresIn = typeof iat === "number" && typeof exp === "number" ? exp - iat : undefined;

    return c.json({ token, expiresIn });
  }
);
