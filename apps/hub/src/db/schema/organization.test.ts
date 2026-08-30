import { describe, expect, test } from "bun:test";
import { prefixedId } from "../../utils/ids";
import { BOOTSTRAP_ORG_ID, PRINCIPAL_KINDS } from "./organization";

describe("principal ids and kinds", () => {
  test("a minted principal id matches the shared grammar", () => {
    // The corpus is the contract; a minter that drifts from it fails at the
    // seam rather than here, which is far more expensive to diagnose.
    expect(prefixedId("prn")).toMatch(/^prn_[0-9a-f]{20}$/);
  });

  test("the bootstrap organisation is a fixed id, not a random one", () => {
    // Same reason tenants.BOOTSTRAP_TENANT_ID is a literal: a fresh deploy and
    // the live hub must agree on it, which a random value cannot guarantee.
    expect(BOOTSTRAP_ORG_ID).toBe("org_00000000000000000000");
  });

  test("kind is closed, and includes the one that did not exist", () => {
    expect(PRINCIPAL_KINDS).toEqual(["human", "agent", "service"]);
  });
});
