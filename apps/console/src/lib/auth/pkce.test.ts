import { describe, expect, test } from "vitest";
import { challengeFor, randomUrlSafe } from "./pkce";

describe("pkce", () => {
  test("verifier is base64url and long enough (RFC 7636: 43-128 chars)", () => {
    const v = randomUrlSafe(48);
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  test("two verifiers are never the same", () => {
    expect(randomUrlSafe(48)).not.toBe(randomUrlSafe(48));
  });

  test("S256 challenge of the RFC 7636 appendix B vector", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
