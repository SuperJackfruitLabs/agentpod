import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { OrgPlaneError } from "../../services/org-plane/client";
import { AssertionMismatch, assertPrincipal, assertionFailureCode } from "./assertion";

/**
 * Contract §3.4b: the hub signs nothing. A human's approval from chat is the plane's assertion,
 * asked for by the sender's Matrix identity — never by a prn_ the hub names.
 */
describe("assertPrincipal (contract §3.4b)", () => {
  const SUBJECT = { principalId: "prn_0000000000000000000a", senderMxid: "@op:id.test" };
  /** Unsigned-enough: assertPrincipal only decodes `sub`; the receiving plane verifies the signature. */
  const tokenFor = (sub: string) =>
    new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("k".repeat(32)));

  test("sends the sender's Matrix identity and returns the plane's token", async () => {
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
  });

  test("a plane token naming a different principal is refused", async () => {
    const other = await tokenFor("prn_0000000000000000000f");
    const err = await assertPrincipal(
      { ...SUBJECT, audience: "https://a" },
      { client: () => ({ assertionToken: async () => ({ accessToken: other, expiresIn: 120 }) }) },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AssertionMismatch);
    expect(assertionFailureCode(err)).toBe("ASSERTION_MISMATCH");
  });

  test.each<[number, string, string]>([
    [403, "not_permitted", "ASSERTION_REFUSED"],
    [404, "unknown_identity", "ASSERTION_REFUSED"],
    [409, "not_human", "ASSERTION_REFUSED"],
    [423, "suspended", "ASSERTION_REFUSED"],
    [0, "unreachable", "IDENTITY_UNAVAILABLE"],
    [503, "unavailable", "IDENTITY_UNAVAILABLE"],
  ])("a plane refusal %i %s propagates as OrgPlaneError, never a hub-signed fallback", async (status, code, receipt) => {
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
    expect(assertionFailureCode(err)).toBe(receipt as never);
  });

  test("any other error has no receipt code", () => {
    expect(assertionFailureCode(new Error("boom"))).toBeNull();
  });
});
