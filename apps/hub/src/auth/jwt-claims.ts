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

/** The kinds of principal this suite has. Humans and agents are both first-class. */
export type PrincipalKind = "human" | "agent" | "service";

export interface TokenPayload extends Record<string, unknown> {
  sub: string;
  principalKind: PrincipalKind;
  tenant: string;
}

export interface BuildPayloadInput {
  user: { id: string };
  /** Injectable so the claim shape is testable without a database. */
  resolveTenant?: (userId: string) => Promise<string>;
}

/**
 * Build the claims for a principal.
 *
 * Throws when no tenant resolves, rather than falling back to a default
 * boundary. A token that verifies but names no tenant is not a weaker caller,
 * it is an unresolvable one, and the fixture requires a consumer to refuse it —
 * so it should never be minted in the first place.
 *
 * The control pair (`mayDispatch`, `mayGrantReach`) is deliberately NOT emitted.
 * Those names are reserved in the fixture and unissued until the Organization
 * plane can answer them; issuing them empty would let a consumer read an empty
 * grant as a real one, and the governing decision requires that absence never
 * mean permission.
 */
export async function buildTokenPayload(input: BuildPayloadInput): Promise<TokenPayload> {
  const resolve = input.resolveTenant ?? resolveTenantForUser;
  const tenant = await resolve(input.user.id);

  if (!tenant) {
    throw new Error(
      `refusing to mint a token for ${input.user.id}: no tenant resolved`
    );
  }

  return {
    sub: input.user.id,
    // Every principal the hub can issue a token for today is a human with a
    // session. An agent gets one by exchanging its own credential, which is a
    // separate path and will set this to "agent".
    principalKind: "human",
    tenant,
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
