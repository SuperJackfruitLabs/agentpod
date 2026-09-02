/**
 * `GET /api/fleet/dispatchable` — the agents a hub token's holder may actually
 * dispatch, with the handles a person recognises.
 *
 * This exists because the obvious answer does not work and could not be made
 * to work safely. kaambaan's agent picker used to ask
 * `GET /api/admin/principals` with `credentials: "include"`, which fails twice
 * over from `kaambaan.dev`: the hub's session cookie is `SameSite=Lax` so a
 * cross-site `fetch` never carries it, and `authMiddleware` accepts a Better
 * Auth session, a session-token Bearer or the static API_TOKEN — never a
 * hub-issued JWT. Teaching that middleware about JWTs would change how EVERY
 * route authenticates for one screen's benefit, and `/api/admin/*` is
 * admin-gated for reasons that have nothing to do with adding an agent to a
 * board. So this is a purpose-built endpoint instead, and it is narrower than
 * the admin list in both directions: it needs no admin role, and it returns
 * only what the caller may use rather than every principal in the fleet.
 *
 * **The authorization decision is read from the verified token and from
 * nowhere else.** `mayDispatch` is a claim this hub signed; it is not a query
 * parameter, not a header, and not derived from anything the caller sent
 * alongside the token. That is the whole endpoint. If the answer could be
 * influenced by the request, this would hand any authenticated caller the
 * whole fleet — which is precisely the list it was built to avoid returning.
 *
 * It authenticates itself, so it is registered ahead of `authMiddleware` in
 * `index.ts`, beside the other self-authenticating routes — see the comment
 * there, and `auth-authorize.ts` for the same structural note.
 */

import { Hono } from "hono";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

import { auth } from "../auth/drizzle-auth";
import { servicePublicJwks } from "../auth/service-signing";
import { config } from "../config";
import { listPrincipals as defaultListPrincipals } from "../services/principals";

/**
 * The one algorithm this hub signs with, on both key sets — Better Auth's
 * `jwt` plugin defaults to it and `service-signing.ts` pins it explicitly.
 *
 * Named here so verification cannot be talked into another one by a token's
 * own header. `jose` would otherwise accept whatever the matched key admits,
 * and "the token says which algorithm to check it with" is the shape of every
 * classic JWT confusion bug.
 */
const ALG = "EdDSA";

/**
 * The key set `GET /api/auth/jwks` publishes: Better Auth's keys plus this
 * hub's service signing keys.
 *
 * Both halves, deliberately, because both halves are what a consumer is told
 * to verify against — kaambaan fetches that one URL and accepts anything in
 * it. A token signed by a service key is a hub token by the ecosystem's own
 * definition (`charter → decisions/2026-08-15-one-issuer-and-offline-
 * verification.md`), and accepting it here widens nothing: what it may
 * enumerate is still exactly the `mayDispatch` the hub put inside it. The
 * bridge's assertion of a human carries that human's grant; a station's own
 * agent token is refused below for being an agent, not for its key.
 *
 * Assembled from the same two sources as the jwks route in `index.ts`. They
 * must agree: a key published there and not accepted here is a token that
 * verifies everywhere in the suite except at this endpoint, which reads as
 * "you have no permission" and is the hardest kind of failure to trace.
 *
 * Not cached. Both reads are local — the hub is the issuer — and a cache would
 * mean a service key minted a second ago (they are created lazily, on first
 * use) verifying as a forgery until it expired.
 */
async function publishedJwks(): Promise<JSONWebKeySet> {
  const betterAuth = (await auth.api.getJwks()) as unknown as JSONWebKeySet;
  return { keys: [...(betterAuth.keys ?? []), ...(await servicePublicJwks())] } as JSONWebKeySet;
}

/**
 * What the route needs from the rest of the hub.
 *
 * Injectable for the same reason `AuthorizeDeps` is: so a test can state a
 * principal list or a key set directly instead of arranging the world that
 * produces one. Real callers pass nothing.
 */
export interface DispatchableDeps {
  /** The keys a token may be signed with. Defaults to the published set. */
  jwks?: () => Promise<JSONWebKeySet>;
  /** Every principal, for resolving ids to handles. Defaults to the real one. */
  listPrincipals?: typeof defaultListPrincipals;
}

/** A refusal that says nothing about which check failed. */
function refuse(description: string) {
  return {
    error: "invalid_token",
    error_description: description,
  } as const;
}

export function createDispatchableRoutes(deps: DispatchableDeps = {}) {
  const jwks = deps.jwks ?? publishedJwks;
  const listPrincipals = deps.listPrincipals ?? defaultListPrincipals;

  return new Hono().get("/api/fleet/dispatchable", async (c) => {
    // `Bearer <token>`, case-insensitively on the scheme, as RFC 6750 has it.
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer +(\S+)$/i.exec(header.trim());
    if (!match) {
      return c.json(
        refuse(
          "This endpoint takes a hub-issued token in `Authorization: Bearer`. It does not read the hub's session cookie, which a browser on another registrable domain would not send anyway."
        ),
        401
      );
    }

    let claims: Record<string, unknown>;
    try {
      const verified = await jwtVerify(match[1]!, createLocalJWKSet(await jwks()), {
        issuer: config.publicUrl,
        audience: config.publicUrl,
        algorithms: [ALG],
      });
      claims = verified.payload as Record<string, unknown>;
    } catch {
      // One sentence for all of: an unknown key, a foreign signature, an
      // expired token, a wrong issuer or audience, a mangled token. A caller
      // holding none of them learns nothing about which; the legitimate caller
      // does not need to be told, because its next move is the same either way
      // — go back through the authorize flow and get a live one.
      return c.json(
        refuse(
          "That token is not one this hub will accept: it is unknown, expired, signed by somebody else, or was not issued for this hub."
        ),
        401
      );
    }

    // An agent's token must not be able to read the fleet. `mayDispatch` is
    // the authority to ASK an agent to work; it was never the authority to
    // find out what else exists, and an agent that enumerates its siblings is
    // an agent doing reconnaissance. This is the same refusal kaambaan's own
    // `resolveHubUser` makes on the human path, and for the same reason.
    if (claims.principalKind !== "human") {
      return c.json(
        refuse(
          "Only a human principal may enumerate dispatchable agents. This token names a " +
            `${typeof claims.principalKind === "string" ? claims.principalKind : "principal of unknown kind"}.`
        ),
        401
      );
    }

    // Read off the VERIFIED claims, never off the request. See the module
    // comment: this line is the endpoint's reason for existing.
    //
    // A non-array claim is read as "permitted nothing" rather than trusted:
    // per `jwt-claims.ts` an absent control pair means "this issuer does not
    // speak it", and reading that as "everything" is the one mistake that
    // cannot be walked back.
    const granted = Array.isArray(claims.mayDispatch)
      ? claims.mayDispatch.filter((v): v is string => typeof v === "string")
      : [];

    // Nothing to offer is not a failure — a fresh operator with no grant sees
    // an empty picker, which is the truth, rather than an error they cannot
    // act on.
    if (granted.length === 0) return c.json({ agents: [] });

    const byId = new Map((await listPrincipals()).map((p) => [p.id, p]));

    const agents: Array<{ id: string; handle: string; displayName: string | null }> = [];
    const seen = new Set<string>();
    for (const id of granted) {
      // A grant may name the same principal twice — nothing forbids it — and a
      // picker that listed an agent twice would read as two agents.
      if (seen.has(id)) continue;
      seen.add(id);

      const principal = byId.get(id);
      // Silently skipped, for an id that resolves to nothing, for one that
      // resolves to a human or a service, and for a suspended agent. A grant
      // naming a deleted principal is a stale grant, not an error to put in
      // front of somebody adding an agent to a board; a grant naming a person
      // is a value this list simply is not about; and a suspended agent cannot
      // be dispatched — the hub refuses to mint it a token at all — so
      // offering it would be offering something that cannot work.
      //
      // Suspension is filtered HERE rather than left to the caller because the
      // response carries no field to say so. That is deliberate: a shape that
      // reported suspension would invite a consumer to render it, and this is
      // a list of what you may use, not an inventory of the fleet.
      if (!principal || principal.kind !== "agent" || principal.suspendedAt !== null) continue;

      agents.push({
        id: principal.id,
        handle: principal.handle,
        displayName: principal.displayName,
      });
    }

    return c.json({ agents });
  });
}

/** The real endpoint, reading the hub's own keys and its own principals. */
export const dispatchableRoutes = createDispatchableRoutes();
