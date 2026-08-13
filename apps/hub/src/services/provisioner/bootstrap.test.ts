/**
 * The wiring test: which drivers `registerEnabledProvisioners()` actually
 * wires up.
 *
 * Registration is the step that has no other test: a driver can be perfect and
 * still be absent from the registry, in which case createRuntime answers
 * "provider not registered" and an operator reads it as a missing feature.
 *
 * This is also the one function that decides whether a hub boots with a working
 * fleet, so a new driver arriving in it is a change to STARTUP — the thing every
 * deployed hub does before it can serve anything. The live-hub test below is the
 * guard on that: the live hub runs docker + cloudflare and has never heard of
 * Fly or Modal, and it must keep booting exactly as it did.
 *
 * No DB and no network: the Docker driver builds a dockerode client lazily and
 * the Cloudflare one only reads env in its constructor, so registration itself
 * talks to nothing. Fly is the exception, and deliberately so — its constructor
 * resolves FLY_API_TOKEN and throws when it is absent.
 *
 * Nothing here constructs the real `ModalClient`. The SDK is 0.x, it falls back
 * to reading an operator's ~/.modal.toml, and a unit test that can reach Modal
 * is a test that fails in CI for reasons that have nothing to do with this repo
 * — so the branch is exercised with a stub client injected at the one seam
 * `createModalApi` already exposes for exactly this.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import { registerEnabledProvisioners } from "./bootstrap";
import {
  enabledProviders,
  getProvisioner,
  getProvisionerUnguarded,
  resetProvisioners,
} from "./registry";
import { setActivityHook } from "../broker";
import type { ModalClientLike } from "./modal-api";

/**
 * Every env var this file touches, saved once and restored at the end.
 *
 * `bun test` runs all files sequentially in ONE process with one module
 * registry, so an env var left set here is set for every later file. The
 * Docker and Cloudflare flags are cleared for a second reason: registering the
 * Cloudflare driver also installs a PROCESS-WIDE broker activity hook, which a
 * test about another substrate has no business leaving behind.
 */
const MANAGED_ENV = [
  "ENABLE_MODAL_PROVISIONING",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "ENABLE_DOCKER_PROVISIONING",
  "ENABLE_CLOUDFLARE_SANDBOXES",
  "ENABLE_FLY_PROVISIONING",
  "FLY_API_TOKEN",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of MANAGED_ENV) savedEnv.set(key, process.env[key]);
});

beforeEach(() => {
  resetProvisioners();
  for (const key of MANAGED_ENV) delete process.env[key];
});

afterEach(() => {
  resetProvisioners();
  // registerEnabledProvisioners installs a broker-wide activity hook when
  // Cloudflare is on. bun test shares one module registry across all files, so
  // leaving it installed would have every later broker request touch a
  // Cloudflare sandbox that does not exist.
  setActivityHook(null);
});

afterAll(() => {
  resetProvisioners();
  for (const key of MANAGED_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Credentials the injected client factory was actually handed, if any. */
let seenCredentials: { tokenId: string; tokenSecret: string } | null = null;

/**
 * Stand-in for `new ModalClient(...)`.
 *
 * Every call throws: a wiring test that reached the substrate would be testing
 * something else, and a silent stub would let such a call pass unnoticed.
 */
const stubClientFactory = (creds: { tokenId: string; tokenSecret: string }) => {
  seenCredentials = creds;
  const refuse = () => {
    throw new Error("stub Modal client: no substrate call belongs in a wiring test");
  };
  return {
    apps: { fromName: refuse },
    volumes: { fromName: refuse, delete: refuse },
    images: { fromRegistry: refuse },
    sandboxes: { create: refuse, fromId: refuse },
  } as unknown as ModalClientLike;
};

beforeEach(() => {
  seenCredentials = null;
});

describe("registerEnabledProvisioners", () => {
  it("boots a docker + cloudflare hub with Fly and Modal off, exactly as before", () => {
    // The live hub's configuration. Fly and Modal are unset — not "false",
    // unset, which is how they reach every existing deployment — and neither
    // FLY_API_TOKEN nor the Modal token pair exists. Registration must not so
    // much as construct those drivers, whose credential resolution would throw
    // and take the boot with it.
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    process.env.ENABLE_CLOUDFLARE_SANDBOXES = "true";

    expect(() => registerEnabledProvisioners()).not.toThrow();

    const enabled = enabledProviders();
    expect(enabled).toContain("docker");
    expect(enabled).toContain("cloudflare");
    expect(enabled).not.toContain("fly");
    expect(enabled).not.toContain("modal");
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

describe("registerEnabledProvisioners — modal", () => {
  it("registers nothing for modal when the flag is off", () => {
    registerEnabledProvisioners({ modalClientFactory: stubClientFactory });
    expect(getProvisionerUnguarded("modal")).toBeUndefined();
  });

  it("registers nothing for modal on credentials alone — the flag is the switch", () => {
    // Credentials present in the environment must not turn a substrate on. An
    // operator who pastes tokens into a hub env while evaluating Modal has not
    // asked for their fleet to start provisioning on it.
    process.env.MODAL_TOKEN_ID = "tok-id";
    process.env.MODAL_TOKEN_SECRET = "tok-secret";
    registerEnabledProvisioners({ modalClientFactory: stubClientFactory });
    expect(getProvisionerUnguarded("modal")).toBeUndefined();
  });

  it("registers the driver when the flag is on and credentials exist", () => {
    process.env.ENABLE_MODAL_PROVISIONING = "true";
    process.env.MODAL_TOKEN_ID = "tok-id";
    process.env.MODAL_TOKEN_SECRET = "tok-secret";
    registerEnabledProvisioners({ modalClientFactory: stubClientFactory });

    const driver = getProvisionerUnguarded("modal");
    expect(driver?.provider).toBe("modal");
    expect(driver?.manifest.stopSemantics).toBe("terminal");
    expect(driver?.manifest.maxLifetimeMs).toBe(86_400_000);

    // The gated lookup, which is the one createRuntime actually uses. A driver
    // present in the map but invisible through this call is a driver an
    // operator cannot provision on.
    expect(getProvisioner("modal")).toBe(driver!);
  });

  it("hands the driver the credentials from the environment", () => {
    // Not decoration: an adapter built with a resolver that reads the wrong
    // place, or with blanks, registers perfectly and then fails every real
    // call with what reads like an auth problem.
    process.env.ENABLE_MODAL_PROVISIONING = "true";
    process.env.MODAL_TOKEN_ID = "tok-id";
    process.env.MODAL_TOKEN_SECRET = "tok-secret";
    registerEnabledProvisioners({ modalClientFactory: stubClientFactory });

    expect(seenCredentials).toEqual({
      tokenId: "tok-id",
      tokenSecret: "tok-secret",
    });
  });

  it("refuses to boot when the flag is on and the credentials are missing", () => {
    // Startup refusal, not a runtime failure on somebody's first provision —
    // and it names both keys so a misconfigured deploy is one fix, not two.
    process.env.ENABLE_MODAL_PROVISIONING = "true";
    expect(() => registerEnabledProvisioners()).toThrow(
      /MODAL_TOKEN_ID.*MODAL_TOKEN_SECRET/
    );
  });

  it("registers no half-built driver when it refuses", () => {
    // A driver in the registry whose substrate has no credentials would answer
    // `enabledProviders()` and be offered in the console, then fail every call.
    process.env.ENABLE_MODAL_PROVISIONING = "true";
    expect(() => registerEnabledProvisioners()).toThrow();
    expect(getProvisionerUnguarded("modal")).toBeUndefined();
  });

  it("names only the missing half of a half-configured pair", () => {
    // Modal's credential is a PAIR, and one-set-one-missing is the case an
    // operator actually hits. Naming both would send them to re-check a
    // variable that was already right.
    process.env.ENABLE_MODAL_PROVISIONING = "true";
    process.env.MODAL_TOKEN_ID = "tok-id";
    let message = "";
    try {
      registerEnabledProvisioners({ modalClientFactory: stubClientFactory });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/MODAL_TOKEN_SECRET/);
    expect(message).not.toMatch(/MODAL_TOKEN_ID/);
  });

  it("treats a blank token as missing, not as configured", () => {
    // Deploy platforms surface an unset secret as "". Accepting it moves the
    // failure to the first provision, where it reads as an auth problem.
    process.env.ENABLE_MODAL_PROVISIONING = "true";
    process.env.MODAL_TOKEN_ID = "tok-id";
    process.env.MODAL_TOKEN_SECRET = "";
    expect(() =>
      registerEnabledProvisioners({ modalClientFactory: stubClientFactory })
    ).toThrow(/MODAL_TOKEN_SECRET/);
  });
});
