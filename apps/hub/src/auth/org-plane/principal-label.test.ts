import { afterEach, describe, expect, test } from "bun:test";
import type { PlanePrincipal } from "./client";
import { setPrincipalDirectoryForTests, type PrincipalDirectory } from "./directory";
import { principalLabel } from "./principals";

/**
 * A gate receipt said "Rejected by mail": it printed the decider's HANDLE, which for a person is
 * the email's local part (mail@example.com signs in as `mail`). The label a person reads is
 * the display name, with the handle only as a fallback.
 */
function directoryWith(p: { handle: string; displayName: string | null } | null): PrincipalDirectory {
  return {
    principal: async (): Promise<PlanePrincipal | null> =>
      p ? { id: "prn_fixture", kind: "human", organizationId: null, suspended: false, grant: null, ...p } : null,
    identity: async () => null,
    identitiesOf: async () => null,
    list: async () => [],
    invalidate: () => {},
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("what a receipt calls the person who decided", () => {
  test("the display name when one is set", async () => {
    restore = setPrincipalDirectoryForTests(directoryWith({ handle: "mail", displayName: "Ada Lovelace" }));
    expect(await principalLabel("prn_fixture")).toBe("Ada Lovelace");
  });

  test("the handle when there is no display name, or only whitespace", async () => {
    restore = setPrincipalDirectoryForTests(directoryWith({ handle: "mail", displayName: null }));
    expect(await principalLabel("prn_fixture")).toBe("mail");
    restore();
    restore = setPrincipalDirectoryForTests(directoryWith({ handle: "mail", displayName: "  " }));
    expect(await principalLabel("prn_fixture")).toBe("mail");
  });

  test("nobody, for an id that names nobody", async () => {
    restore = setPrincipalDirectoryForTests(directoryWith(null));
    expect(await principalLabel("prn_missing")).toBeNull();
  });
});
