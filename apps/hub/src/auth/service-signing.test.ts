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

import { describe, expect, test, beforeAll } from "bun:test";
import { decodeJwt } from "jose";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createPrincipal } from "../services/principals";
import { mintPrincipalAssertion } from "./service-signing";

beforeAll(async () => {
  await ensurePgMigrations();
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

    expect(claims.sub).toBe(principalId);
    expect(claims.principalKind).toBe("agent");
  });
});
