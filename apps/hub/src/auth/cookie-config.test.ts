/**
 * Unit tests for sessionCookieOptions and allowedOrigins.
 * No DB connection required — all pure functions from config.ts.
 */
import { describe, it, expect } from "bun:test";
import { sessionCookieOptions, allowedOrigins, isAllowedOrigin } from "../config";

describe("sessionCookieOptions", () => {
  it("returns prod options when COOKIE_DOMAIN and COOKIE_SECURE are set", () => {
    const opts = sessionCookieOptions({ COOKIE_DOMAIN: ".agentpod.dev", COOKIE_SECURE: "true" });
    expect(opts.domain).toBe(".agentpod.dev");
    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(true);
  });

  it("returns dev-safe options when env vars are absent", () => {
    const opts = sessionCookieOptions({});
    expect(opts.domain).toBeUndefined();
    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(false);
  });

  it("treats empty/whitespace COOKIE_DOMAIN as unset", () => {
    const opts = sessionCookieOptions({ COOKIE_DOMAIN: "  ", COOKIE_SECURE: "false" });
    expect(opts.domain).toBeUndefined();
    expect(opts.secure).toBe(false);
  });

  it("sameSite is always lax regardless of env", () => {
    const devOpts = sessionCookieOptions({});
    const prodOpts = sessionCookieOptions({ COOKIE_DOMAIN: ".agentpod.dev", COOKIE_SECURE: "true" });
    expect(devOpts.sameSite).toBe("lax");
    expect(prodOpts.sameSite).toBe("lax");
  });
});

describe("allowedOrigins (unified list)", () => {
  it("includes https://console.agentpod.dev by default", () => {
    expect(allowedOrigins).toContain("https://console.agentpod.dev");
  });

  it("includes localhost dev origins", () => {
    expect(allowedOrigins).toContain("http://localhost:5173");
  });
});

describe("isAllowedOrigin (from unified list)", () => {
  it("allows https://console.agentpod.dev", () => {
    expect(isAllowedOrigin("https://console.agentpod.dev")).toBe(true);
  });

  it("rejects the retired https://app.agentpod.dev", () => {
    expect(isAllowedOrigin("https://app.agentpod.dev")).toBe(false);
  });

  it("rejects unknown origin", () => {
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedOrigin("http://localhost:9999")).toBe(false);
  });

  it("allows null/undefined/empty origin (server-to-server — no CSWSH risk)", () => {
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("")).toBe(true);
  });

  it("allows local LAN IP origins (development)", () => {
    expect(isAllowedOrigin("http://192.168.1.100:5173")).toBe(true);
    expect(isAllowedOrigin("http://10.0.0.5:1420")).toBe(true);
  });
});
