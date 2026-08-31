/**
 * Service Test: service-signing (minting an assertion for a principal)
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 *
 * This exercises `mintPrincipalAssertion` itself, not a copy of its logic —
 * `jwt-claims.test.ts`'s injected-resolver tests prove `buildTokenPayload`
 * handles a `principalId` correctly, but nothing there would notice if
 * `service-signing.ts` stopped calling it that way. It did, once: it called
 * `buildTokenPayload({ user: { id: input.principalId } })`, which pushed a
 * `prn_…` id through the Better-Auth-session resolver and threw for every
 * principal that had no session — which was every gate approval minted from
 * a phone. This test fails the same way if that line ever comes back.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { config } from "../config";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { rawSql } from "../db/drizzle";
import { createPrincipal } from "../services/principals";
import { BRIDGE_ACTOR, mintPrincipalAssertion, servicePublicJwks } from "./service-signing";

// Fixed handle, cleaned up on both ends: running this suite twice against the
// same database (no reset between runs, unlike CI) must not hit
// "principals_org_handle_idx" on the second pass.
beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM principals WHERE handle = 'assertion-target'`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM principals WHERE handle = 'assertion-target'`;
  } catch {
    // cleanup only
  }
});

describe("mintPrincipalAssertion", () => {
  test("asserts the principal it was handed, without a Better Auth session to fall back to", async () => {
    // Deliberately no `userId`: this principal has no `principal_identities`
    // row for Better Auth to find. If `mintPrincipalAssertion` ever again
    // hands `buildTokenPayload` a `user: { id }` shaped input, resolving this
    // id as a session subject finds nothing and throws — there is no other
    // way for this principal to end up in a minted token.
    const principalId = await createPrincipal({ kind: "agent", handle: "assertion-target" });

    const token = await mintPrincipalAssertion({ principalId });
    const claims = decodeJwt(token);
    const header = decodeProtectedHeader(token);

    expect(claims.sub).toBe(principalId);
    expect(claims.principalKind).toBe("agent");

    // The claim this whole module exists for: WHO minted it is recorded
    // distinctly from WHO it is minted for. Asserting only sub/principalKind
    // (as this test used to) stays green even if `act` is deleted entirely —
    // that would silently make an assertion indistinguishable from the
    // principal's own token, exactly the impersonation-without-a-trace this
    // module's own doc comment says must not be possible.
    expect(claims.act).toEqual({ sub: BRIDGE_ACTOR });

    // iss/aud: this hub, both ends — a consumer verifies against a specific
    // issuer/audience pair, and a drift here is a token nothing accepts.
    expect(claims.iss).toBe(config.publicUrl);
    expect(claims.aud).toBe(config.publicUrl);

    // alg/kid: EdDSA, matching Better Auth's own jwt plugin and what
    // kaambaan pins — a different algorithm here is a token no consumer's
    // pinned verifier would even attempt.
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBeTruthy();

    // The kid must be one this hub actually publishes — otherwise a
    // consumer's offline verification (the entire point of a separate
    // service key) fails for a token that was, in fact, validly signed.
    const published = await servicePublicJwks();
    expect(published.some((k) => k.kid === header.kid)).toBe(true);

    // TTL is what it claims to be: ~120s, not the 5-minute session TTL and
    // not unbounded. A wide tolerance (not exact-equality) because iat/exp
    // are wall-clock seconds and the assertion cost real time to mint.
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    const ttlSeconds = (claims.exp as number) - (claims.iat as number);
    expect(ttlSeconds).toBeGreaterThan(100);
    expect(ttlSeconds).toBeLessThanOrEqual(120);
  });
});
