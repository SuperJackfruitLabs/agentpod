/**
 * Unit tests: which drivers `registerEnabledProvisioners()` actually wires up.
 *
 * This is the one function that decides whether a hub boots with a working
 * fleet, so the Fly driver arriving in it is a change to STARTUP — the thing
 * every deployed hub does before it can serve anything. The first test here is
 * the guard on that: the live hub runs docker + cloudflare and has never heard
 * of Fly, and it must keep booting exactly as it did.
 *
 * No DB and no network: the Docker driver builds a dockerode client lazily and
 * the Cloudflare one only reads env in its constructor, so registration itself
 * talks to nothing. The Fly driver is the exception, and deliberately so — its
 * constructor resolves FLY_API_TOKEN and throws when it is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { registerEnabledProvisioners } from "./bootstrap";
import { enabledProviders, getProvisioner, resetProvisioners } from "./registry";
import { setActivityHook } from "../broker";

const ENV_KEYS = [
  "ENABLE_DOCKER_PROVISIONING",
  "ENABLE_CLOUDFLARE_SANDBOXES",
  "ENABLE_FLY_PROVISIONING",
  "FLY_API_TOKEN",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetProvisioners();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetProvisioners();
  // registerEnabledProvisioners installs a broker-wide activity hook when
  // Cloudflare is on. bun test shares one module registry across all files, so
  // leaving it installed would have every later broker request touch a
  // Cloudflare sandbox that does not exist.
  setActivityHook(null);
});

describe("registerEnabledProvisioners", () => {
  it("boots a docker + cloudflare hub with Fly off, exactly as before", () => {
    // The live hub's configuration. Fly is unset — not "false", unset, which is
    // how it will reach every existing deployment — and FLY_API_TOKEN does not
    // exist. Registration must not so much as construct the Fly driver, whose
    // constructor would throw on the missing token and take the boot with it.
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    process.env.ENABLE_CLOUDFLARE_SANDBOXES = "true";

    expect(() => registerEnabledProvisioners()).not.toThrow();

    const enabled = enabledProviders();
    expect(enabled).toContain("docker");
    expect(enabled).toContain("cloudflare");
    expect(enabled).not.toContain("fly");
  });

  it("registers Fly when its flag is on and its token is present", () => {
    process.env.ENABLE_FLY_PROVISIONING = "true";
    process.env.FLY_API_TOKEN = "fly-test-token";

    registerEnabledProvisioners();

    expect(enabledProviders()).toContain("fly");
    expect(getProvisioner("fly").manifest.provider).toBe("fly");
    // Measured facts the manifest carries; if either flips, the image's volume
    // wrapper and the hub's idle handling are both wrong.
    expect(getProvisioner("fly").manifest.workspaceStorage).toBe("volume");
    expect(getProvisioner("fly").manifest.idleBehaviour).toBe("hub-driven");
  });

  it("refuses to register an enabled-but-tokenless Fly, naming the variable", () => {
    // The deliberate choice, and the reason validate-config refuses the boot
    // first: a driver that cannot authenticate does not quietly half-register.
    // Cloudflare defaults its token to "" and registers regardless, so an
    // unconfigured Cloudflare hub looks healthy until the first provision
    // returns an auth error. Fly does not copy that; the operator learns at
    // boot, from a message with the variable name in it.
    process.env.ENABLE_FLY_PROVISIONING = "true";

    expect(() => registerEnabledProvisioners()).toThrow(/FLY_API_TOKEN/);
    expect(enabledProviders()).not.toContain("fly");
  });

  it("registers docker before it reaches Fly, so a Fly misconfiguration is legible", () => {
    // Ordering matters for the failure, not for the feature: docker and
    // cloudflare are registered first, so the throw above is unambiguously
    // about Fly rather than about a registry left half-built.
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    process.env.ENABLE_FLY_PROVISIONING = "true";

    expect(() => registerEnabledProvisioners()).toThrow(/FLY_API_TOKEN/);
    expect(enabledProviders()).toEqual(["docker"]);
  });
});
