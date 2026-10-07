/**
 * `GET /api/fleet/dispatchable` — the agents a plane token's holder may actually
 * dispatch, with the handles a person recognises.
 *
 * Built for superpipeline's agent picker, from another registrable domain. It is
 * narrower than the admin list in both directions: it needs no admin role, and it
 * returns only what the caller may use rather than every principal in the fleet.
 *
 * **The authorization decision is read from the verified token and from
 * nowhere else.** `mayDispatch` is a claim the org plane signed; it is not a query
 * parameter, not a header, and not derived from anything the caller sent
 * alongside the token. That is the whole endpoint. If the answer could be
 * influenced by the request, this would hand any authenticated caller the
 * whole fleet — which is precisely the list it was built to avoid returning.
 *
 * It authenticates itself, so it is registered ahead of `authMiddleware` in
 * `index.ts`, beside the other self-authenticating routes.
 */

import { Hono } from "hono";

import { verifyPlaneBearer } from "../auth/hub-token";
import { listPrincipals as defaultListPrincipals } from "../services/principals";

/**
 * What the route needs from the rest of the hub. Injectable so a test can state a principal list
 * or a verification result directly. Real callers pass nothing.
 */
export interface DispatchableDeps {
  /** Every principal, for resolving ids to handles. Defaults to the real one. */
  listPrincipals?: typeof defaultListPrincipals;
  /** The one verifying door every route shares. */
  verifyPlane?: typeof verifyPlaneBearer;
}

/** A refusal that says nothing about which check failed. */
function refuse(description: string) {
  return {
    error: "invalid_token",
    error_description: description,
  } as const;
}

export function createDispatchableRoutes(deps: DispatchableDeps = {}) {
  const listPrincipals = deps.listPrincipals ?? defaultListPrincipals;
  const verifyPlane = deps.verifyPlane ?? verifyPlaneBearer;

  return new Hono().get("/api/fleet/dispatchable", async (c) => {
    // `Bearer <token>`, case-insensitively on the scheme, as RFC 6750 has it.
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer +(\S+)$/i.exec(header.trim());
    if (!match) {
      return c.json(
        refuse(
          "This endpoint takes an organization-plane token in `Authorization: Bearer`. It does not read a session cookie, which a browser on another registrable domain would not send anyway."
        ),
        401
      );
    }

    // Any first-party client's human token for this hub's audience is accepted —
    // superpipeline-web asks for one for its picker (contract §3.1).
    const r = await verifyPlane(match[1]!);
    if (!r.ok) {
      // One sentence for all of: an unknown key, a foreign signature, an expired token, a wrong
      // issuer or audience, a mangled token. The legitimate caller's next move is the same either
      // way — get a live one.
      return r.status === 403
        ? c.json(r.body, 403)
        : c.json(
            refuse(
              "That token is not one this hub will accept: it is unknown, expired, signed by somebody else, or was not issued for this hub."
            ),
            401
          );
    }
    const claims = r.caller.claims as Record<string, unknown>;

    // An agent's token must not be able to read the fleet. `mayDispatch` is
    // the authority to ASK an agent to work; it was never the authority to
    // find out what else exists, and an agent that enumerates its siblings is
    // an agent doing reconnaissance. This is the same refusal superpipeline's own
    // `resolveHubUser` makes on the human path, and for the same reason.
    if (claims.principalKind !== "human") {
      return c.json(
        refuse(
          "Only a human principal may enumerate dispatchable agents. This token's principal kind is " +
            `${typeof claims.principalKind === "string" ? claims.principalKind : "not stated"}.`
        ),
        401
      );
    }

    // Read off the VERIFIED claims, never off the request. See the module
    // comment: this line is the endpoint's reason for existing.
    //
    // A non-array claim is read as "permitted nothing" rather than trusted:
    // per contract §2 an absent control pair means "this issuer does not
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

/** The real endpoint: the plane's tokens, and principals read through the plane. */
export const dispatchableRoutes = createDispatchableRoutes();
