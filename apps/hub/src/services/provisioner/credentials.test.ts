/**
 * Unit Test: provisioner credential resolver (P4 Task 8)
 *
 * No DB or external I/O — pure unit test. The env-backed resolver is exercised
 * against `process.env` directly and restores whatever it changed.
 */

import { it, expect, describe, afterEach } from "bun:test";
import {
  envCredentialResolver,
  requireCredentials,
  type CredentialResolver,
} from "./credentials";

describe("requireCredentials", () => {
  it("refuses to register a driver whose credentials are missing", () => {
    const resolver: CredentialResolver = { get: () => undefined };
    expect(() =>
      requireCredentials("fly", ["FLY_API_TOKEN"], resolver)
    ).toThrow(/FLY_API_TOKEN/);
  });

  it("returns the resolved values when present", () => {
    const resolver: CredentialResolver = {
      get: (k: string) => (k === "FLY_API_TOKEN" ? "tok" : undefined),
    };
    expect(requireCredentials("fly", ["FLY_API_TOKEN"], resolver)).toEqual({
      FLY_API_TOKEN: "tok",
    });
  });

  it("names the provider in the error", () => {
    const resolver: CredentialResolver = { get: () => undefined };
    expect(() => requireCredentials("modal", ["MODAL_TOKEN_ID"], resolver)).toThrow(
      /modal/
    );
  });

  it("reports every missing key, not just the first", () => {
    // A partially configured provider: one key set, two absent. Reporting only
    // the first missing key costs an operator one deploy per key; this is why
    // the whole set is collected before throwing.
    const resolver: CredentialResolver = {
      get: (k: string) => (k === "MODAL_TOKEN_ID" ? "id" : undefined),
    };
    let message = "";
    try {
      requireCredentials(
        "modal",
        ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_WORKSPACE"],
        resolver
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("MODAL_TOKEN_SECRET");
    expect(message).toContain("MODAL_WORKSPACE");
    // The key that *was* configured must not be blamed.
    expect(message).not.toContain("MODAL_TOKEN_ID");
  });

  it("treats an empty string as missing", () => {
    // An unset secret in a deploy platform commonly surfaces as "" rather than
    // undefined; letting that through hands the driver a token it cannot use.
    const resolver: CredentialResolver = { get: () => "" };
    expect(() => requireCredentials("fly", ["FLY_API_TOKEN"], resolver)).toThrow(
      /FLY_API_TOKEN/
    );
  });

  it("returns an empty object when no keys are required", () => {
    const resolver: CredentialResolver = { get: () => undefined };
    expect(requireCredentials("docker", [], resolver)).toEqual({});
  });
});

describe("envCredentialResolver", () => {
  const touched: string[] = [];

  afterEach(() => {
    for (const key of touched.splice(0)) delete process.env[key];
  });

  it("reads values from process.env", () => {
    touched.push("AGENTPOD_TEST_CRED");
    process.env.AGENTPOD_TEST_CRED = "value-from-env";
    expect(envCredentialResolver().get("AGENTPOD_TEST_CRED")).toBe(
      "value-from-env"
    );
  });

  it("returns undefined for an unset key", () => {
    expect(
      envCredentialResolver().get("AGENTPOD_TEST_CRED_DEFINITELY_UNSET")
    ).toBeUndefined();
  });

  it("reads process.env at call time, not at construction time", () => {
    // The hub constructs resolvers during module init; a resolver that
    // snapshotted process.env would go stale against anything set later.
    const resolver = envCredentialResolver();
    touched.push("AGENTPOD_TEST_CRED_LATE");
    process.env.AGENTPOD_TEST_CRED_LATE = "late";
    expect(resolver.get("AGENTPOD_TEST_CRED_LATE")).toBe("late");
  });

  it("satisfies requireCredentials end to end", () => {
    touched.push("AGENTPOD_TEST_TOKEN");
    process.env.AGENTPOD_TEST_TOKEN = "tok";
    expect(
      requireCredentials("fly", ["AGENTPOD_TEST_TOKEN"], envCredentialResolver())
    ).toEqual({ AGENTPOD_TEST_TOKEN: "tok" });
  });
});
