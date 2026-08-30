/**
 * What goes inside a hub-issued token.
 *
 * Split out of the Better Auth config on purpose: these claim names are a
 * contract the moment a second plane reads them
 * (charter decisions/2026-08-15-one-issuer-and-offline-verification.md), and a
 * contract that only exists inside a plugin's options object cannot be tested
 * against the shared fixture. `fixtures/ecosystem-identity/token_claims.json` is
 * the source of truth; `tests/unit/jwt-issuer.test.ts` holds this to it.
 *
 * A rename here is a silent authorization failure in kaambaan, and it fails in
 * the direction that looks like the caller simply having no permission — which
 * is the hardest kind of bug to notice.
 */

import { resolveTenantForUser } from "./tenant";
import { getGrant } from "../services/grants";
import { principalById, principalForUser } from "../services/principals";
import type { PrincipalKind } from "../db/schema/organization";

export type { PrincipalKind };

/**
 * The default `resolvePrincipal`: `principalForUser` from one joined query
 * (`principal_identities` ⋈ `principals`), returning the id AND the kind
 * together — a second query for kind would be two round trips answering one
 * question.
 */
const defaultResolvePrincipal = principalForUser;

/**
 * The default `resolvePrincipalById`, for a caller that already holds a
 * principal id and must not have it re-resolved through Better Auth (see
 * `principalById`'s doc comment for why `defaultResolvePrincipal` cannot
 * stand in for this).
 */
const defaultResolvePrincipalById = principalById;

export interface TokenPayload extends Record<string, unknown> {
  sub: string;
  principalKind: PrincipalKind;
  tenant: string;
  /** The control pair. Namespaced values; see the grant decision. */
  mayDispatch: string[];
  mayGrantReach: boolean;
}

export interface BuildPayloadInput {
  /**
   * A caller with a Better Auth session. Resolved to a principal via
   * `resolvePrincipal`. Mutually exclusive with `principalId` below — pass
   * exactly one.
   */
  user?: { id: string };
  /**
   * A caller that already holds a principal id, obtained by an explicit
   * lookup elsewhere (e.g. `principal_identities` by mxid). Trusted as-is:
   * this id is checked to exist via `resolvePrincipalById`, never
   * re-resolved through `resolvePrincipal`/Better Auth. This is the path
   * `mintPrincipalAssertion` uses — its subject is never a session, and
   * treating it as one would silently answer "no principal" for a principal
   * that does exist.
   */
  principalId?: string;
  /** Injectable so the claim shape is testable without a database. */
  resolveTenant?: (userId: string) => Promise<string | null>;
  /** Injectable for the same reason. Keyed by principal id, not user id. */
  loadGrant?: (
    principalId: string
  ) => Promise<{ mayDispatch: string[]; mayGrantReach: boolean } | null>;
  /** Injectable for the same reason. Defaults to `principalForUser`. Used only on the `user` path. */
  resolvePrincipal?: (userId: string) => Promise<{ id: string; kind: PrincipalKind } | null>;
  /** Injectable for the same reason. Defaults to `principalById`. Used only on the `principalId` path. */
  resolvePrincipalById?: (id: string) => Promise<{ id: string; kind: PrincipalKind } | null>;
}

/**
 * Build the claims for a principal.
 *
 * Takes exactly one of two callers. `user: { id }` is a Better Auth session:
 * its id is resolved to a principal via `resolvePrincipal`
 * (`principalForUser` by default), which looks the id up as a Better Auth
 * external id and can therefore only ever answer for a session. `principalId`
 * is a caller that already holds a principal id from elsewhere —
 * `mintPrincipalAssertion` asserting a Matrix sender it looked up in
 * `principal_identities` — and that id is trusted as-is: it is checked to
 * exist via `resolvePrincipalById` (`principalById` by default, a lookup by
 * primary key) and used directly as `sub`, never pushed back through
 * `resolvePrincipal` where it would read as an unmapped Better Auth id and
 * fail closed for a principal that is very much real.
 *
 * Resolves the principal FIRST, and refuses to mint when none resolves. A
 * token that verifies but names nobody is not a weaker caller, it is an
 * unattributable one — the same reasoning as the no-tenant refusal below, and
 * it applies before the tenant lookup because a claim naming no one has
 * nothing to attach a tenant to.
 *
 * `sub` and `principalKind` come from the resolved principal, not from the
 * caller passed in — an agent's token says it is an agent because the
 * principal it maps to is one, not because of a separate exchange path.
 *
 * Throws when no tenant resolves, rather than falling back to a default
 * boundary. A token that verifies but names no tenant is not a weaker caller,
 * it is an unresolvable one, and the fixture requires a consumer to refuse it —
 * so it should never be minted in the first place.
 *
 * The control pair IS emitted now that grants are data the issuer can read
 * (`principal_grants`). It was reserved-and-unissued while the answer lived in
 * each deployment's environment, because a claim nobody could answer would have
 * been a claim consumers had to ignore.
 *
 * A principal with **no grant row** gets the claims present and EMPTY —
 * `[]` and `false` — rather than absent. The difference matters to a consumer:
 * absent means "this issuer does not speak the control pair", empty means "this
 * principal is permitted nothing". Reading the first as the second would let an
 * old issuer silently authorise everything.
 */
export async function buildTokenPayload(input: BuildPayloadInput): Promise<TokenPayload> {
  let principal: { id: string; kind: PrincipalKind } | null;
  let who: string;

  if (input.principalId !== undefined) {
    who = input.principalId;
    const resolveById = input.resolvePrincipalById ?? defaultResolvePrincipalById;
    principal = await resolveById(input.principalId);
  } else if (input.user) {
    who = input.user.id;
    const resolvePrincipal = input.resolvePrincipal ?? defaultResolvePrincipal;
    principal = await resolvePrincipal(input.user.id);
  } else {
    throw new Error("buildTokenPayload requires either `user` or `principalId`");
  }

  if (!principal) {
    throw new Error(`refusing to mint a token for ${who}: no principal resolved`);
  }

  const resolve = input.resolveTenant ?? resolveTenantForUser;
  const tenant = await resolve(who);

  if (!tenant) {
    throw new Error(`refusing to mint a token for ${who}: no tenant resolved`);
  }

  const loadGrant = input.loadGrant ?? getGrant;
  const grant = await loadGrant(principal.id);

  return {
    sub: principal.id,
    principalKind: principal.kind,
    tenant,
    mayDispatch: grant?.mayDispatch ?? [],
    mayGrantReach: grant?.mayGrantReach ?? false,
  };
}

/**
 * How long a token lives — and therefore, exactly, how long a revoked session's
 * last token stays usable.
 *
 * agentpod#331 established this by running it: a token issued before a sign-out
 * keeps verifying until it expires, because verification is offline by design
 * and no consumer asks the issuer anything. There is no revocation list to
 * consult; **the expiry IS the revocation SLA.**
 *
 * Five minutes because a caller holding a session can mint another whenever it
 * needs one, so the cost of a short life is a round trip the caller was already
 * able to make — while the cost of a long one is a stolen token that outlives
 * the response to it.
 */
export const TOKEN_TTL = "5m";
