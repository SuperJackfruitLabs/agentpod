/**
 * Verifying the organization plane's tokens (contract §1-§2, design §5.5).
 *
 * The rules are treaty's (`verifyAccessToken`, `@superjackfruitlabs/treaty-ecosystem-identity`),
 * the same in every product and held to `token_vectors.json`: EdDSA over Ed25519 only, fixed and
 * never taken from the token's header; a `kid` required; `iss` exact; `aud` equal to or containing
 * this hub's audience; 30 s of leeway on `exp`, `nbf` and `iat`; a lifetime of at most 300 s;
 * `jti`, `mayDispatch` and `mayGrantReach` required, `sub` and `org` in the id grammar, every
 * `mayDispatch` value a prn (any other value refuses the token); `ent` containing this verifier's
 * product. `client_id`, `azp`, `sid` pass through and are ignored (contract §2); `amr` is never
 * required. The claims are then read as the hub's `OrgPlaneTokenClaims`.
 *
 * Keys come from treaty's `createJwksCache`: cached up to ten minutes, refreshed behind a stale
 * set (stale while revalidate: once any set has been fetched, a request never waits on a routine
 * refresh), refetched on an unknown `kid` at most once per 30 s, every fetch bounded by 3 s, and
 * the last good set served while the plane is unreachable — the hub keeps admitting valid tokens
 * through a plane outage, which is the property design §9 "Offline" tests. What the hub adds is
 * in the fetch it hands the cache: after a failed fetch, no other is made for `retryAfterMs`, so
 * a down plane is not asked again on every request; and the fetch settles at its timeout even
 * when an injected fetch ignores the signal, so a plane that accepts TCP and never answers cannot
 * stall a request (security review finding 2).
 */
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  AccessTokenError,
  createJwksCache,
  verifyAccessToken,
  type AccessTokenErrorCode,
} from "@superjackfruitlabs/treaty-ecosystem-identity";
import { OrgPlaneTokenClaims } from "@agentpod/contract";

import { AGENTPOD_PRODUCT, orgPlane } from "./config";
import { createLogger } from "../../utils/logger";

const log = createLogger("org-plane-verify");
const TEN_MINUTES = 10 * 60 * 1000;

export interface PlaneVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** The product `ent` must contain: `agentpod` at the hub's own doors, `superpipeline` for a grant it spends there. */
  product: string;
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  now?: () => number;
  /** Capped at ten minutes whatever is passed. */
  maxAgeMs?: number;
  /** Minimum gap between fetches after a failed one. Default 30 s. */
  retryAfterMs?: number;
  /** Minimum gap between refetches triggered by unknown kids, whichever kids they are. Default 30 s. */
  kidRefetchMs?: number;
  /** Upper bound on one JWKS fetch, body included. Default 3 s. */
  fetchTimeoutMs?: number;
}

/** Why a token was refused: treaty's code, or no key set to check it against. */
export type PlaneRefusal = AccessTokenErrorCode | "keys_unavailable";

/**
 * A verification's outcome. A token refused only for its product (`product_not_enabled`) carries
 * its `org`, read after its signature and every other claim were checked, so a door can answer
 * the org's 403 rather than a 401.
 */
export type PlaneCheck =
  | { ok: true; claims: OrgPlaneTokenClaims }
  | { ok: false; code: PlaneRefusal; org?: string };

export interface PlaneVerifier {
  /** The claims of a token this verifier accepts, or null. */
  verify(token: string): Promise<OrgPlaneTokenClaims | null>;
  /** The same, saying why a token was refused. */
  check(token: string): Promise<PlaneCheck>;
}

export function createPlaneVerifier(o: PlaneVerifierOptions): PlaneVerifier {
  const fetchFn =
    o.fetch ??
    ((url: string, init?: { signal?: AbortSignal }) =>
      fetch(url, { headers: { accept: "application/json" }, signal: init?.signal }));
  const now = o.now ?? Date.now;
  const retryAfter = o.retryAfterMs ?? 30_000;
  let lastFailure = Number.NEGATIVE_INFINITY;

  /** The fetch the cache makes: rate-limited after a failure, and settled at its signal's abort. */
  const guarded: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      if (now() - lastFailure < retryAfter) throw new Error("JWKS fetch failed recently; not retried yet");
      const signal = init?.signal ?? undefined;
      try {
        const res = await settledBy(fetchFn(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, { signal }), signal);
        if (!res.ok) lastFailure = now();
        return res;
      } catch (error) {
        lastFailure = now();
        log.warn("JWKS refresh failed; serving the last good set, if any", { error: String(error) });
        throw error;
      }
    },
    { preconnect: fetch.preconnect },
  );

  const keys = createJwksCache({
    url: o.jwksUrl,
    fetch: guarded,
    now,
    timeoutMs: o.fetchTimeoutMs ?? 3_000,
    refetchUnknownKidAfterMs: o.kidRefetchMs ?? 30_000,
    maxAgeMs: Math.min(o.maxAgeMs ?? TEN_MINUTES, TEN_MINUTES),
  });

  async function check(token: string): Promise<PlaneCheck> {
    // Keys are looked up only for a token that could use one: a wrong algorithm or a missing kid
    // is refused by treaty's verifier against an empty set, and never makes the plane be asked.
    let lookup: string | null = null;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg === "EdDSA" && typeof header.kid === "string" && header.kid !== "") lookup = header.kid;
    } catch {
      // Malformed: treaty's verifier says so.
    }
    let jwks: { keys: unknown[] } = { keys: [] };
    if (lookup !== null) {
      try {
        jwks = await keys.getKeys(lookup);
      } catch {
        return { ok: false, code: "keys_unavailable" };
      }
    }
    try {
      const claims = await verifyAccessToken(token, {
        jwks,
        issuer: o.issuer,
        audience: o.audience,
        product: o.product,
        now: Math.floor(now() / 1000),
      });
      const parsed = OrgPlaneTokenClaims.safeParse(claims);
      return parsed.success ? { ok: true, claims: parsed.data } : { ok: false, code: "bad_claim" };
    } catch (error) {
      if (!(error instanceof AccessTokenError)) return { ok: false, code: "malformed" };
      if (error.code !== "product_not_enabled") return { ok: false, code: error.code };
      // Treaty checks the product last, so the token is otherwise good and its org is in grammar.
      const org = decodeJwt(token).org;
      return { ok: false, code: error.code, ...(typeof org === "string" ? { org } : {}) };
    }
  }

  return {
    check,
    async verify(token) {
      const checked = await check(token);
      return checked.ok ? checked.claims : null;
    },
  };
}

/** `p`, or a rejection once `signal` aborts: an injected fetch may ignore the signal. */
function settledBy<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("JWKS fetch timed out"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Shared verifiers by fetch, then issuer, audience, key-set URL and product. The default fetch keys on this object. */
const sharedVerifiers = new WeakMap<object, Map<string, PlaneVerifier>>();
const defaultFetchKey = {};

/**
 * One verifier per issuer, audience, key-set URL and product (and injected fetch), kept for the process.
 * A verifier made per request has no key set, so its first `verify` always fetches the JWKS: on
 * the checkpoint path that was a key-set round trip inside every Node `current` decision. Sharing
 * keeps only public keys; rotation is still honoured (an unknown `kid` refetches at once, a stale
 * set is revalidated), so no token is ever accepted that a fresh verifier would refuse.
 */
export function sharedPlaneVerifier(o: PlaneVerifierOptions): PlaneVerifier {
  const owner = o.fetch ?? defaultFetchKey;
  let byKey = sharedVerifiers.get(owner);
  if (!byKey) sharedVerifiers.set(owner, (byKey = new Map()));
  const key = [o.issuer, o.audience, o.jwksUrl, o.product].join("\0");
  let verifier = byKey.get(key);
  if (!verifier) byKey.set(key, (verifier = createPlaneVerifier(o)));
  return verifier;
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
      verifier: createPlaneVerifier({ issuer: plane.issuer, audience: plane.audience, jwksUrl: plane.jwksUrl, product: AGENTPOD_PRODUCT }),
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
