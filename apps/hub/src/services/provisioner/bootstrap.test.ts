/**
 * The wiring test.
 *
 * Registration is the step that has no other test: a driver can be perfect and
 * still be absent from the registry, in which case createRuntime answers
 * "provider not registered" and an operator reads it as a missing feature.
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
  getProvisioner,
  getProvisionerUnguarded,
  resetProvisioners,
} from "./registry";
import type { ModalClientLike } from "./modal-api";

/**
 * Every env var this file touches, saved once and restored at the end.
 *
 * `bun test` runs all 59 files sequentially in ONE process with one module
 * registry, so an env var left set here is set for every later file. The
 * Docker and Cloudflare flags are cleared for a second reason: registering the
 * Cloudflare driver also installs a PROCESS-WIDE broker activity hook, which a
 * test about Modal has no business leaving behind.
 */
const MANAGED_ENV = [
  "ENABLE_MODAL_PROVISIONING",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "ENABLE_DOCKER_PROVISIONING",
  "ENABLE_CLOUDFLARE_SANDBOXES",
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
