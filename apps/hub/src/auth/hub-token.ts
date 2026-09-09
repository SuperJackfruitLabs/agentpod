/**
 * Verifying a token this hub itself issued.
 *
 * **The asymmetry this closes.** `charter → decisions/2026-08-15-one-issuer-and-offline-
 * verification.md` makes the hub the issuer and has every other plane verify offline against a
 * JWKS. kaambaan does exactly that. The hub did not: until now, exactly one route in this
 * codebase — `/api/fleet/dispatchable`, built for the cross-domain handoff — would read a
 * hub-issued token, and every other `/api/*` route went through `authMiddleware`, which accepts
 * a session cookie, the static `API_TOKEN`, or a Better Auth session token, and none of those
 * is a hub JWT.
 *
 * The practical consequence was that a client completing the authorization-code flow received a
 * credential that opened a single endpoint. A CLI could sign in and then 401 on its first real
 * request.
 *
 * **One verifier, deliberately.** This module exists so `fleet-dispatchable` and
 * `authMiddleware` cannot drift: two implementations of "is this token ours" is precisely how a
 * key published in one place comes to be rejected in another, and that failure reads as "you
 * have no permission", which is the hardest kind to trace.
 */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

import { config } from "../config.ts";
import { auth } from "./drizzle-auth.ts";
import { servicePublicJwks } from "./service-signing.ts";

/**
 * Pinned, never read from the token's own header.
 *
 * `jose` would otherwise accept whatever the matched key admits, which lets a caller choose the
 * algorithm — the classic JWT confusion attack.
 */
export const ALG = "EdDSA";

/**
 * Every key a token of ours may be signed with: Better Auth's, plus the service keys.
 *
 * Assembled from the same two sources as the `jwks` route, and they must agree — a key
 * published there and refused here is a token that verifies everywhere in the suite except at
 * this hub.
 *
 * Not cached. Both reads are local, and a cache would mean a service key minted a second ago
 * (they are created lazily, on first use) verifying as a forgery until it expired.
 */
export async function publishedJwks(): Promise<JSONWebKeySet> {
  const betterAuth = (await auth.api.getJwks()) as unknown as JSONWebKeySet;
  return { keys: [...(betterAuth.keys ?? []), ...(await servicePublicJwks())] } as JSONWebKeySet;
}

export interface HubTokenClaims {
  sub: string;
  principalKind: "human" | "agent" | "service";
  tenant?: string;
  mayDispatch?: string[];
  mayGrantReach?: boolean;
  [claim: string]: unknown;
}

/**
 * Verify a bearer string as a hub-issued token, or return null.
 *
 * Null for every failure — unknown key, foreign signature, expired, wrong issuer or audience,
 * mangled — because a caller holding none of them learns nothing from being told which, and a
 * legitimate caller's next move is the same either way: go back through the authorize flow.
 */
export async function verifyHubToken(
  token: string,
  jwks: () => Promise<JSONWebKeySet> = publishedJwks,
): Promise<HubTokenClaims | null> {
  try {
    const verified = await jwtVerify(token, createLocalJWKSet(await jwks()), {
      issuer: config.publicUrl,
      audience: config.publicUrl,
      algorithms: [ALG],
    });
    const claims = verified.payload as Record<string, unknown>;
    if (typeof claims.sub !== "string" || typeof claims.principalKind !== "string") return null;
    return claims as unknown as HubTokenClaims;
  } catch {
    return null;
  }
}
