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
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";
import { config } from "../config";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { db, rawSql } from "../db/drizzle";
import { serviceSigningKeys } from "../db/schema/service-keys";
import { setOrgPlaneForTests, TEST_PLANE } from "./org-plane/config";
import { OrgPlaneError } from "../services/org-plane/client";
import { createPrincipal } from "../services/principals";
import { AssertionMismatch, BRIDGE_ACTOR, assertPrincipal, mintPrincipalAssertion, servicePublicJwks } from "./service-signing";

// Fixed handle, cleaned up on both ends: running this suite twice against the
// same database (no reset between runs, unlike CI) must not hit
// "principals_org_handle_idx" on the second pass.
beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM principals WHERE handle = 'assertion-target'`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM principals WHERE handle IN ('assertion-target', 'aud-target', 'aud-target-2', 'aud-target-3')`;
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
    // superpipeline pins — a different algorithm here is a token no consumer's
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

/**
 * agentpod#604's last mile: a human's approval travelled from their phone, through
 * the board room, past the human-only check, and came back `HTTP_401`.
 *
 * `signServiceToken` falls back to the hub's own URL when no audience is given —
 * and that URL is the issuer. As this file's own comment puts it, "an audience that
 * equals the issuer is not an audience check; it is the issuer check, written
 * twice." A plane verifying `aud` against its own origin refuses such a token.
 */
describe("an assertion for another plane", () => {
  test("names that plane, so the plane verifying aud accepts it", async () => {
    const principalId = await createPrincipal({ kind: "human", handle: "aud-target" });
    const token = await mintPrincipalAssertion({
      principalId,
      audiences: ["https://app.superpipeline.dev"],
    });
    const claims = decodeJwt(token);
    expect(claims.aud).toEqual(["https://app.superpipeline.dev"]);
    // Still issued by the hub — the audience says where it may be spent, not who
    // signed it.
    expect(claims.iss).not.toEqual(claims.aud);
  });

  test("with no audience it stays hub-only, which is the safe default", async () => {
    const principalId = await createPrincipal({ kind: "human", handle: "aud-target-2" });
    const token = await mintPrincipalAssertion({ principalId });
    const claims = decodeJwt(token);
    expect(typeof claims.aud).toBe("string");
    expect(claims.aud).toBe(claims.iss);
  });

  test("the subject is still the principal, never the bridge", async () => {
    // The whole decision of 2026-08-14 rests here: a bridge substituting its own
    // identity would void superpipeline's separation-of-duties check.
    const principalId = await createPrincipal({ kind: "human", handle: "aud-target-3" });
    const token = await mintPrincipalAssertion({
      principalId,
      audiences: ["https://app.superpipeline.dev"],
    });
    expect(decodeJwt(token).sub).toBe(principalId);
  });
});

/**
 * Contract §3.4b: under the org plane the hub signs nothing. A human's approval from chat is the
 * plane's assertion, asked for by the sender's Matrix identity — never by a prn_ the hub names.
 */
describe("assertPrincipal under the plane (contract §3.4b)", () => {
  const SUBJECT = { principalId: "prn_0000000000000000000a", senderMxid: "@op:id.test" };
  /** Unsigned-enough: assertPrincipal only decodes `sub`; the receiving plane verifies the signature. */
  const tokenFor = (sub: string) =>
    new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("k".repeat(32)));

  test("sends the sender's Matrix identity, returns the plane's token, touches no hub key", async () => {
    const before = (await db.select().from(serviceSigningKeys)).length;
    const restore = setOrgPlaneForTests(TEST_PLANE);
    try {
      const asked: unknown[] = [];
      const plane = await tokenFor(SUBJECT.principalId);
      const token = await assertPrincipal(
        { ...SUBJECT, audience: "https://app.superpipeline.test" },
        {
          client: () => ({
            assertionToken: async (identity, audience) => (asked.push({ identity, audience }), { accessToken: plane, expiresIn: 120 }),
          }),
        },
      );
      expect(token).toBe(plane);
      expect(asked).toEqual([{ identity: { system: "matrix", externalId: "@op:id.test" }, audience: "https://app.superpipeline.test" }]);
    } finally {
      restore();
    }
    expect((await db.select().from(serviceSigningKeys)).length).toBe(before);
  });

  test("a plane token naming a different principal is refused", async () => {
    const restore = setOrgPlaneForTests(TEST_PLANE);
    try {
      const other = await tokenFor("prn_0000000000000000000f");
      const err = await assertPrincipal(
        { ...SUBJECT, audience: "https://a" },
        { client: () => ({ assertionToken: async () => ({ accessToken: other, expiresIn: 120 }) }) },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(AssertionMismatch);
    } finally {
      restore();
    }
  });

  test.each([
    [403, "not_permitted"],
    [404, "unknown_identity"],
    [409, "not_human"],
    [423, "suspended"],
    [0, "unreachable"],
  ])("a plane refusal %i %s propagates as OrgPlaneError, never a hub-signed fallback", async (status, code) => {
    const before = (await db.select().from(serviceSigningKeys)).length;
    const restore = setOrgPlaneForTests(TEST_PLANE);
    try {
      const err = await assertPrincipal(
        { ...SUBJECT, audience: "https://a" },
        {
          client: () => ({
            assertionToken: async () => {
              throw new OrgPlaneError(status, code);
            },
          }),
        },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(OrgPlaneError);
      expect(err.code).toBe(code);
    } finally {
      restore();
    }
    expect((await db.select().from(serviceSigningKeys)).length).toBe(before);
  });

  test("legacy mode still signs with the hub's key, as today, and never asks the plane", async () => {
    await rawSql`DELETE FROM principals WHERE handle = 'assert-legacy-target'`;
    const human = await createPrincipal({ kind: "human", handle: "assert-legacy-target" });
    try {
      let asked = 0;
      const token = await assertPrincipal(
        { principalId: human, senderMxid: "@x:id.test", audience: "https://a" },
        { client: () => ({ assertionToken: async () => (asked++, { accessToken: "x", expiresIn: 1 }) }) },
      );
      expect(asked).toBe(0);
      expect(decodeJwt(token).sub).toBe(human);
      expect(decodeJwt(token).act).toEqual({ sub: BRIDGE_ACTOR });
      expect(decodeJwt(token).aud).toEqual(["https://a"]);
    } finally {
      await rawSql`DELETE FROM principals WHERE handle = 'assert-legacy-target'`;
    }
  });
});
