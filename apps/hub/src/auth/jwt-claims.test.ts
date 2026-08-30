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
