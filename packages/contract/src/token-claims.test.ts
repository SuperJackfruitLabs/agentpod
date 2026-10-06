import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrgPlaneTokenClaims, audienceIncludes } from "./token-claims";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "ecosystem-identity", "token_claims.json"), "utf8"),
) as {
  version: number;
  issued: Array<{ claim: string; required: boolean }>;
  standard: Array<{ claim: string; required?: boolean }>;
  conditional: Array<{ claim: string }>;
  reject: Array<{ case: string }>;
};

const valid = {
  iss: "https://accounts.superjackfruit.com",
  sub: "prn_0123456789abcdef0123",
  aud: "https://hub.agentpod.dev",
  exp: 1_900_000_300,
  iat: 1_900_000_000,
  jti: "b7f1c0de",
  principalKind: "agent",
  org: "org_00000000000000000000",
  ent: ["agentpod", "superpipeline"],
  mayDispatch: [],
  mayGrantReach: false,
};

describe("token_claims.json v8 ↔ OrgPlaneTokenClaims", () => {
  test("the fixture is v8 and no longer issues tenant", () => {
    expect(fixture.version).toBe(8);
    expect(fixture.issued.map((c) => c.claim)).not.toContain("tenant");
  });

  test("every claim the fixture names is a key of the schema, and the reverse", () => {
    const described = new Set([...fixture.issued, ...fixture.standard, ...fixture.conditional].map((c) => c.claim));
    expect([...described].sort()).toEqual(Object.keys(OrgPlaneTokenClaims.shape).sort());
  });

  test("every required issued and standard claim is required by the schema", () => {
    const required = [...fixture.issued, ...fixture.standard].filter((c) => c.required);
    // iss/aud/exp/iat/jti + sub/principalKind/org/ent/mayDispatch/mayGrantReach.
    expect(required.map((c) => c.claim).sort()).toEqual(
      ["aud", "ent", "exp", "iat", "iss", "jti", "mayDispatch", "mayGrantReach", "org", "principalKind", "sub"],
    );
    for (const { claim } of required) {
      const { [claim]: _dropped, ...rest } = valid as Record<string, unknown>;
      expect(OrgPlaneTokenClaims.safeParse(rest).success).toBe(false);
    }
  });

  test("a v7 hub token (tenant, no org/ent) is refused — reject case missing-org", () => {
    expect(fixture.reject.map((r) => r.case)).toContain("missing-org");
    const { org: _o, ent: _e, ...v7 } = valid;
    expect(OrgPlaneTokenClaims.safeParse({ ...v7, tenant: "fleet_00000000000000000000" }).success).toBe(false);
  });

  test("aud may be a string or a non-empty array", () => {
    expect(OrgPlaneTokenClaims.safeParse({ ...valid, aud: ["https://hub.agentpod.dev", "x"] }).success).toBe(true);
    expect(OrgPlaneTokenClaims.safeParse({ ...valid, aud: [] }).success).toBe(false);
  });

  test("unknown extra claims (client_id, azp, sid) pass through", () => {
    const r = OrgPlaneTokenClaims.safeParse({ ...valid, client_id: "agentpod-console", azp: "x", sid: "y" });
    expect(r.success).toBe(true);
  });

  test("audienceIncludes: equals or contains, never a prefix", () => {
    expect(audienceIncludes("https://hub.agentpod.dev", "https://hub.agentpod.dev")).toBe(true);
    expect(audienceIncludes(["a", "https://hub.agentpod.dev"], "https://hub.agentpod.dev")).toBe(true);
    expect(audienceIncludes("https://hub.agentpod.dev/x", "https://hub.agentpod.dev")).toBe(false);
    expect(audienceIncludes(["a"], "https://hub.agentpod.dev")).toBe(false);
  });
});
