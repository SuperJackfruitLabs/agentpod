import { describe, expect, test } from "bun:test";

import { buildTokenPayload } from "./jwt-claims";

/**
 * `principalKind` stops being the literal `"human"`, and `sub` stops being a
 * Better Auth user id — both become whatever the resolved principal actually
 * is. These inject `resolvePrincipal` so they need no database
 * (see `hub-tests-need-a-database`): the point under test is what
 * `buildTokenPayload` does with a resolved principal, not how one gets
 * resolved.
 */
describe("buildTokenPayload names its principal", () => {
  test("an agent's token says it is an agent, and names the principal", async () => {
    const payload = await buildTokenPayload({
      user: { id: "usr-uuid" },
      resolvePrincipal: async () => ({ id: "prn_0123456789abcdef0123", kind: "agent" }),
      resolveTenant: async () => "fleet_00000000000000000000",
      loadGrant: async () => ({ mayDispatch: [], mayGrantReach: false }),
    });
    expect(payload.principalKind).toBe("agent");
    expect(payload.sub).toBe("prn_0123456789abcdef0123");
  });

  test("refuses to mint for a caller with no principal", async () => {
    // Same shape as the no-tenant refusal below it: a token that verifies but
    // names nobody is not a weaker caller, it is an unattributable one.
    expect(
      buildTokenPayload({ user: { id: "usr-unmapped" }, resolvePrincipal: async () => null })
    ).rejects.toThrow(/no principal/);
  });
});

/**
 * A caller that already holds a principal id — e.g. a Matrix sender resolved
 * through `principal_identities` — must never have that id re-resolved
 * through Better Auth. `mintPrincipalAssertion` (service-signing.ts) is
 * exactly this caller: it hands `buildTokenPayload` a `prn_…` id it already
 * trusts, and `defaultResolvePrincipal` (keyed on a Better Auth external id)
 * cannot answer for it — every gate approval minted this way threw before
 * this fix.
 */
describe("buildTokenPayload for a caller that already holds a principal id", () => {
  test("mints without re-resolving through Better Auth, and names the right kind", async () => {
    const payload = await buildTokenPayload({
      principalId: "prn_0123456789abcdef0123",
      resolvePrincipalById: async (id) =>
        id === "prn_0123456789abcdef0123" ? { id, kind: "agent" } : null,
      resolveTenant: async () => "fleet_00000000000000000000",
      loadGrant: async () => ({ mayDispatch: [], mayGrantReach: false }),
    });
    expect(payload.sub).toBe("prn_0123456789abcdef0123");
    expect(payload.principalKind).toBe("agent");
  });

  test("refuses to mint for a principal id that does not exist, rather than falling back", async () => {
    expect(
      buildTokenPayload({
        principalId: "prn_doesnotexist00000000",
        resolvePrincipalById: async () => null,
      })
    ).rejects.toThrow(/no principal/);
  });
});
