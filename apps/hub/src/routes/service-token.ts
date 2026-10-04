/**
 * `POST /api/auth/service-token` — a SERVICE principal (superwitness) exchanges its long-lived
 * credential for a five-minute token (superwitness contract C6).
 *
 * `Authorization: Bearer <svc_id>:<secret>`, parsed exactly as the device and station exchanges
 * parse theirs — one scheme for every long-lived credential this hub accepts.
 *
 * The audiences come from the client the CREDENTIAL names, never from the request: a holder
 * cannot widen where its token may be spent. Claims come from `buildTokenPayload`, so `scope` is
 * the grant's and a suspended principal is refused. No `act`: the service presents its own
 * credential, nobody speaks for anybody.
 *
 * Self-authenticating, so it is mounted beside `deviceRoutes`, ahead of Better Auth's catch-all
 * and of `authMiddleware` (`index.ts`).
 */
import { Hono } from "hono";
import { decodeJwt } from "jose";

import { buildTokenPayload, TOKEN_TTL } from "../auth/jwt-claims";
import { signServiceToken } from "../auth/service-signing";
import { findOAuthClient, oauthClients, type OAuthClient } from "../config";
import { principalById } from "../services/principals";
import { exchangeServiceCredential } from "../services/service-credentials";

export function createServiceTokenRoutes(deps: { clients?: readonly OAuthClient[] } = {}) {
  const registry = deps.clients ?? oauthClients;
  return new Hono().post("/service-token", async (c) => {
    const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const idx = bearer.indexOf(":");
    const id = idx !== -1 ? bearer.slice(0, idx) : "";
    const secret = idx !== -1 ? bearer.slice(idx + 1) : "";

    const cred = await exchangeServiceCredential(id, secret);
    if (!cred) return c.json({ error: "invalid service credential" }, 401);

    const principal = await principalById(cred.principalId);
    if (!principal || principal.kind !== "service") {
      return c.json({ error: "this credential does not name a service principal" }, 403);
    }
    const client = findOAuthClient(cred.oauthClient, registry);
    if (!client) return c.json({ error: "this credential's client is not registered on this hub" }, 403);

    let payload;
    try {
      payload = await buildTokenPayload({ principalId: cred.principalId });
    } catch {
      // Suspended, or no tenant: the refusal buildTokenPayload already makes.
      return c.json({ error: "no token may be minted for this principal" }, 403);
    }

    const token = await signServiceToken({ payload, subject: cred.principalId, ttl: TOKEN_TTL, audiences: client.audiences });
    const { iat, exp } = decodeJwt(token);
    return c.json({ token, expiresIn: typeof iat === "number" && typeof exp === "number" ? exp - iat : 300 });
  });
}

export const serviceTokenRoutes = createServiceTokenRoutes();
