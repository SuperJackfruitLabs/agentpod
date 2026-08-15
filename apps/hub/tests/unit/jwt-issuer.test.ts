import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const fixture = JSON.parse(
  readFileSync(join(REPO_ROOT, "fixtures/ecosystem-identity/token_claims.json"), "utf8")
) as {
  algorithm: { alg: string };
  issued: Array<{ claim: string; required: boolean; enum?: string[] }>;
  standard: Array<{ claim: string }>;
  reserved: Array<{ claim: string; issuedToday: boolean }>;
};

/**
 * The hub as the suite's token issuer
 * (charter decisions/2026-08-15-one-issuer-and-offline-verification.md).
 *
 * These assert the CONTRACT, not the library. The moment kaambaan reads a claim,
 * the claim's name is shared: a rename here is a silent authorization failure
 * over there, and it fails in the direction that looks like the caller simply
 * having no permission — which is the hardest kind of bug to see.
 *
 * So the fixture is the source of truth and this file checks the hub against it,
 * exactly as `contractfix` keeps five hand-written Go mirrors honest.
 *
 * What is deliberately NOT here: proof that a JWT verifies, that rotation
 * overlaps, or that verification works with the issuer down. Those are
 * properties of better-auth and jose, they were established by running them
 * (agentpod#331), and re-asserting them here would test somebody else's library
 * on every CI run.
 */
describe("the token claim contract (#332)", () => {
  test("the payload builder emits every claim the fixture calls required", async () => {
    const { buildTokenPayload } = await import("../../src/auth/jwt-claims");

    const payload = await buildTokenPayload({
      user: { id: "user_abc123" },
      resolveTenant: async () => "fleet_0123456789abcdef0123",
    });

    for (const { claim, required } of fixture.issued) {
      if (!required) continue;
      expect(payload, `fixture requires the claim "${claim}"`).toHaveProperty(claim);
    }
  });

  test("emits no claim the fixture does not describe", async () => {
    // The other direction, and the one that catches drift: a claim the hub
    // invents is a claim no peer knows to read, and the fixture is where a peer
    // looks.
    const { buildTokenPayload } = await import("../../src/auth/jwt-claims");
    const payload = await buildTokenPayload({
      user: { id: "user_abc123" },
      resolveTenant: async () => "fleet_0123456789abcdef0123",
    });

    const described = new Set([
      ...fixture.issued.map((c) => c.claim),
      ...fixture.standard.map((c) => c.claim),
      ...fixture.reserved.map((c) => c.claim),
    ]);

    const undescribed = Object.keys(payload).filter((k) => !described.has(k));
    expect(undescribed).toEqual([]);
  });

  test("does not issue a reserved claim", async () => {
    // `mayDispatch` and `mayGrantReach` are spoken for and not yet issued.
    // Issuing them empty would be worse than omitting them: a consumer could
    // read an empty grant as a real one, and the decision requires that absence
    // never means permission.
    const { buildTokenPayload } = await import("../../src/auth/jwt-claims");
    const payload = await buildTokenPayload({
      user: { id: "user_abc123" },
      resolveTenant: async () => "fleet_0123456789abcdef0123",
    });

    for (const { claim, issuedToday } of fixture.reserved) {
      if (issuedToday) continue;
      expect(payload, `"${claim}" is reserved, not issued`).not.toHaveProperty(claim);
    }
  });

  test("principalKind is one the fixture allows", async () => {
    const { buildTokenPayload } = await import("../../src/auth/jwt-claims");
    const payload = await buildTokenPayload({
      user: { id: "user_abc123" },
      resolveTenant: async () => "fleet_0123456789abcdef0123",
    });

    const allowed = fixture.issued.find((c) => c.claim === "principalKind")?.enum ?? [];
    expect(allowed).toContain(payload.principalKind as string);
  });

  test("the tenant claim carries the hub's own boundary, in the id grammar", async () => {
    const { buildTokenPayload } = await import("../../src/auth/jwt-claims");
    const payload = await buildTokenPayload({
      user: { id: "user_abc123" },
      resolveTenant: async () => "fleet_0123456789abcdef0123",
    });

    const grammar = fixture.issued.find((c) => c.claim === "tenant")!;
    expect(payload.tenant).toMatch(new RegExp((grammar as { grammar: string }).grammar));
  });

  test("a principal with no resolvable tenant produces no token, rather than a default one", async () => {
    // Failing closed. A token that verifies but names no boundary is not a
    // weaker caller, it is an unresolvable one — and the fixture's `reject` list
    // says a consumer must refuse it. Better that it is never minted.
    const { buildTokenPayload } = await import("../../src/auth/jwt-claims");

    await expect(
      buildTokenPayload({
        user: { id: "user_abc123" },
        resolveTenant: async () => null as unknown as string,
      })
    ).rejects.toThrow(/tenant/i);
  });
});
