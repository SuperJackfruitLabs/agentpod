import { describe, expect, test } from "bun:test";
import { readOrgPlaneConfig } from "./config";

const FULL = {
  ORG_PLANE_ISSUER: "https://accounts.superjackfruit.com",
  ORG_PLANE_JWKS_URL: "https://accounts.superjackfruit.com/api/auth/jwks",
  ORG_PLANE_AUDIENCE: "https://hub.agentpod.dev",
  ORG_PLANE_URL: "https://accounts.superjackfruit.com/",
  ORG_PLANE_SERVICE_CREDENTIAL_FILE: "/run/secrets/hub-svc",
};
const file = (body: string) => () => body;

describe("readOrgPlaneConfig", () => {
  test("nothing set is the legacy mode: config null, no errors", () => {
    expect(readOrgPlaneConfig({})).toEqual({ ok: true, config: null });
  });

  test("blank values count as unset", () => {
    expect(readOrgPlaneConfig({ ORG_PLANE_ISSUER: "  " })).toEqual({ ok: true, config: null });
  });

  test("all five set yields the config, the issuer kept exactly as written", () => {
    const r = readOrgPlaneConfig(FULL, file("svc_0123456789abcdef0123:abc-DEF_123\n"));
    expect(r).toEqual({
      ok: true,
      config: {
        issuer: "https://accounts.superjackfruit.com",
        jwksUrl: "https://accounts.superjackfruit.com/api/auth/jwks",
        audience: "https://hub.agentpod.dev",
        url: "https://accounts.superjackfruit.com",
        serviceCredential: { id: "svc_0123456789abcdef0123", secret: "abc-DEF_123" },
      },
    });
  });

  test("a partial set refuses to boot and names every missing variable", () => {
    const { ORG_PLANE_AUDIENCE: _a, ORG_PLANE_URL: _u, ...partial } = FULL;
    const r = readOrgPlaneConfig(partial, file("svc_0123456789abcdef0123:x"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field).sort()).toEqual(["ORG_PLANE_AUDIENCE", "ORG_PLANE_URL"]);
    // The refusal is the all-or-none rule, not a downstream symptom (an empty URL is "not a URL").
    for (const e of r.errors) expect(e.message).toContain("all-or-none");
  });

  test("an unreadable credential file is an error, and the error never echoes file contents", () => {
    const r = readOrgPlaneConfig(FULL, () => {
      throw new Error("ENOENT");
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.field).toBe("ORG_PLANE_SERVICE_CREDENTIAL_FILE");
  });

  test("a credential that is not svc_<20 hex>:<secret> is refused without printing it", () => {
    const r = readOrgPlaneConfig(FULL, file("dev_0123456789abcdef0123:leaky"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.errors)).not.toContain("leaky");
  });

  test("an empty credential file is an error, not a silent fall back to legacy mode", () => {
    const r = readOrgPlaneConfig(FULL, file("\n"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field)).toEqual(["ORG_PLANE_SERVICE_CREDENTIAL_FILE"]);
  });

  test("plain http is allowed for a loopback host", () => {
    const r = readOrgPlaneConfig(
      { ...FULL, ORG_PLANE_URL: "http://127.0.0.1:3000", ORG_PLANE_JWKS_URL: "http://localhost:3000/jwks" },
      file("svc_0123456789abcdef0123:x"),
    );
    expect(r.ok).toBe(true);
  });

  test("plain http is refused for a non-loopback host", () => {
    const r = readOrgPlaneConfig({ ...FULL, ORG_PLANE_JWKS_URL: "http://accounts.superjackfruit.com/jwks" }, file("svc_0123456789abcdef0123:x"));
    expect(r.ok).toBe(false);
  });
});
