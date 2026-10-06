/**
 * Verifying the organization plane's tokens (contract §1-§2, design §5.5).
 *
 * - Key set cached ≤ 10 minutes; refetched on an unknown `kid`.
 * - The last good key set is served while the plane is unreachable — the hub keeps admitting
 *   valid tokens through a plane outage, which is the property design §9 "Offline" tests.
 * - EdDSA only, fixed here, never taken from the token's header.
 * - `iss` exact; `aud` equals or contains this hub's audience.
 * - Refetches are rate-limited so neither an outage nor a stream of rogue kids turns every
 *   request into a call to the plane: a stale or failed set retries once per `retryAfterMs`;
 *   an unknown kid refetches at once, but only the first time that kid is seen and at most
 *   once per `kidRefetchMs` across all kids.
 * - `client_id`, `azp`, `sid` pass through and are ignored (contract §2); `amr` is never required.
 */
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWK } from "jose";
import { OrgPlaneTokenClaims } from "@agentpod/contract";

import { orgPlane } from "./config";
import { createLogger } from "../../utils/logger";

const log = createLogger("org-plane-verify");
const TEN_MINUTES = 10 * 60 * 1000;
const ALG = "EdDSA";
const MAX_TRIED_KIDS = 100;

export interface PlaneVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  fetch?: (url: string) => Promise<Response>;
  now?: () => number;
  /** Capped at ten minutes whatever is passed. */
  maxAgeMs?: number;
  /** Minimum gap between refetches of a stale set (or after a failed fetch). */
  retryAfterMs?: number;
  /** Minimum gap between refetches triggered by unknown kids, whichever kids they are. */
  kidRefetchMs?: number;
}

export interface PlaneVerifier {
  verify(token: string): Promise<OrgPlaneTokenClaims | null>;
}

export function createPlaneVerifier(o: PlaneVerifierOptions): PlaneVerifier {
  const fetchFn = o.fetch ?? ((url: string) => fetch(url, { headers: { accept: "application/json" } }));
  const now = o.now ?? Date.now;
  const maxAge = Math.min(o.maxAgeMs ?? TEN_MINUTES, TEN_MINUTES);
  const retryAfter = o.retryAfterMs ?? 30_000;
  const kidRefetch = o.kidRefetchMs ?? 5_000;

  let good: { keys: JWK[]; at: number } | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let lastKidRefetch = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;
  const triedKids = new Set<string>();

  function refresh(force = false): Promise<void> {
    if (inflight) return inflight;
    if (!force && now() - lastAttempt < retryAfter) return Promise.resolve();
    lastAttempt = now();
    inflight = (async () => {
      try {
        const res = await fetchFn(o.jwksUrl);
        if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
        const body = (await res.json()) as { keys?: unknown };
        if (!Array.isArray(body.keys)) throw new Error("JWKS has no keys array");
        const keys = (body.keys as JWK[]).filter((k) => k && k.kty === "OKP" && k.crv === "Ed25519");
        good = { keys, at: now() };
      } catch (error) {
        log.warn("JWKS refresh failed; serving the last good set", {
          error: String(error),
          lastGoodAgeMs: good ? now() - good.at : null,
        });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    async verify(token) {
      let kid: string | undefined;
      try {
        const header = decodeProtectedHeader(token);
        if (header.alg !== ALG) return null;
        kid = header.kid;
      } catch {
        return null;
      }

      if (!good || now() - good.at >= maxAge) await refresh();
      if (
        good &&
        kid &&
        !good.keys.some((k) => k.kid === kid) &&
        !triedKids.has(kid) &&
        now() - lastKidRefetch >= kidRefetch
      ) {
        if (triedKids.size >= MAX_TRIED_KIDS) triedKids.clear();
        triedKids.add(kid);
        lastKidRefetch = now();
        await refresh(true); // contract: refetch on unknown kid, so a rotated key verifies at once
      }
      if (!good) return null;

      try {
        const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: good.keys } as JSONWebKeySet), {
          issuer: o.issuer, // exact string compare
          audience: o.audience, // jose accepts aud equal to, or an array containing, this
          algorithms: [ALG],
          currentDate: new Date(now()),
        });
        const parsed = OrgPlaneTokenClaims.safeParse(payload);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}

let singleton: { plane: ReturnType<typeof orgPlane>; verifier: PlaneVerifier } | null = null;
let override: PlaneVerifier | null = null;

/** Lazy singleton built from `orgPlane()`, rebuilt if the configured plane changes. */
export function planeVerifier(): PlaneVerifier {
  if (override) return override;
  const plane = orgPlane();
  if (singleton?.plane !== plane) {
    singleton = {
      plane,
      verifier: createPlaneVerifier({ issuer: plane.issuer, audience: plane.audience, jwksUrl: plane.jwksUrl }),
    };
  }
  return singleton.verifier;
}

/** Tests: verify against a key set the test controls instead of fetching the plane's. */
export function setPlaneVerifierForTests(v: PlaneVerifier | null): () => void {
  const previous = override;
  override = v;
  return () => {
    override = previous;
  };
}
