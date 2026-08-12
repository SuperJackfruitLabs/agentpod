/**
 * Unit Test: provisioner registry (P4 Task 4)
 *
 * Verifies env-flag gating, registration, and error-throwing logic
 * for getProvisioner / enabledProviders.
 *
 * No DB or external I/O — pure unit test.
 */

import { test, it, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  registerProvisioner,
  enabledProviders,
  providerManifests,
  getProvisioner,
  resetProvisioners,
} from "./registry";
import type { RuntimeProvisioner, ProvisionSpec } from "./types";
import { DockerRuntimeProvisioner } from "./docker";

// ─── Fake provisioner factories ───────────────────────────────────────────────

// Each fake declares a manifest that matches what the fake itself does: it
// provisions and destroys, nothing more. These are registry tests, so the
// values only have to be coherent — but they are real DriverManifests, not
// casts, because a cast here would hide exactly the omission the required
// field exists to catch.

function fakeDockerProvisioner(): RuntimeProvisioner {
  return {
    provider: "docker",
    manifest: {
      provider: "docker",
      workspaceStorage: "rootfs",
      stopSemantics: "resumable",
      maxLifetimeMs: null,
      imageBinding: "per-instance",
      supportedTiers: ["small", "medium", "large"],
      idleBehaviour: "never",
      lifecycle: [],
    },
    async provision(_spec: ProvisionSpec) {
      return { externalId: "container-fake-001" };
    },
    async destroy(_externalId: string) {},
  };
}

function fakeCloudflareProvisioner(): RuntimeProvisioner {
  return {
    provider: "cloudflare",
    manifest: {
      provider: "cloudflare",
      workspaceStorage: "external-archive",
      stopSemantics: "resumable",
      maxLifetimeMs: null,
      imageBinding: "fixed",
      supportedTiers: ["large"],
      idleBehaviour: "platform-inbound",
      lifecycle: [],
    },
    async provision(_spec: ProvisionSpec) {
      return { externalId: "cf-sandbox-fake-001" };
    },
    async destroy(_externalId: string) {},
  };
}

// ─── Env snapshot helpers ─────────────────────────────────────────────────────

let savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const k of keys) {
    savedEnv[k] = process.env[k];
  }
}

function restoreEnv(...keys: string[]) {
  for (const k of keys) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
  savedEnv = {};
}

const ENV_KEYS = [
  "ENABLE_DOCKER_PROVISIONING",
  "ENABLE_CLOUDFLARE_SANDBOXES",
  // A driver the registry has never been told about, used below to prove a new
  // one needs no edit here to be gated.
  "ENABLE_FLY_PROVISIONING",
];

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  resetProvisioners();
  saveEnv(...ENV_KEYS);
  // Start with both flags off
  delete process.env.ENABLE_DOCKER_PROVISIONING;
  delete process.env.ENABLE_CLOUDFLARE_SANDBOXES;
  delete process.env.ENABLE_FLY_PROVISIONING;
});

afterEach(() => {
  restoreEnv(...ENV_KEYS);
  resetProvisioners();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("enabledProviders — env gating", () => {
  test("both flags unset → enabledProviders() is []", () => {
    expect(enabledProviders()).toEqual([]);
  });

  test("ENABLE_DOCKER_PROVISIONING=true → docker appears in enabledProviders (only if registered)", () => {
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    registerProvisioner(fakeDockerProvisioner());
    const enabled = enabledProviders();
    expect(enabled).toContain("docker");
    expect(enabled).not.toContain("cloudflare");
  });

  test("ENABLE_CLOUDFLARE_SANDBOXES=true → cloudflare appears in enabledProviders (only if registered)", () => {
    process.env.ENABLE_CLOUDFLARE_SANDBOXES = "true";
    registerProvisioner(fakeCloudflareProvisioner());
    const enabled = enabledProviders();
    expect(enabled).toContain("cloudflare");
    expect(enabled).not.toContain("docker");
  });

  test("both flags on, both registered → both appear", () => {
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    process.env.ENABLE_CLOUDFLARE_SANDBOXES = "true";
    registerProvisioner(fakeDockerProvisioner());
    registerProvisioner(fakeCloudflareProvisioner());
    const enabled = enabledProviders();
    expect(enabled).toContain("docker");
    expect(enabled).toContain("cloudflare");
  });
});

describe("getProvisioner — error cases", () => {
  test("unknown provider → throws 'unknown provider: bogus'", () => {
    expect(() => getProvisioner("bogus")).toThrow("unknown provider: bogus");
  });

  test("registered provider (docker) but flag off → throws 'provider disabled: docker'", () => {
    // A registered driver is what makes "docker" a real name now, so the
    // disabled path is reached through one — not through a literal set of
    // provider names that the registry has to be told about separately.
    // Flag is unset (both deleted in beforeEach).
    registerProvisioner(fakeDockerProvisioner());
    expect(() => getProvisioner("docker")).toThrow("provider disabled: docker");
  });

  test("flag on but not registered → throws 'provider not registered: docker'", () => {
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    // No registerProvisioner call
    expect(() => getProvisioner("docker")).toThrow("provider not registered: docker");
  });

  test("flag on but not registered (cloudflare) → throws 'provider not registered: cloudflare'", () => {
    process.env.ENABLE_CLOUDFLARE_SANDBOXES = "true";
    expect(() => getProvisioner("cloudflare")).toThrow("provider not registered: cloudflare");
  });
});

describe("provider names are data, not a literal set", () => {
  test("a driver this file has never heard of registers, and is gated by ENABLE_<NAME>_PROVISIONING", () => {
    // No edit anywhere in the registry was needed to name "fly": the flag name
    // is derived from the provider, so a new driver arrives with its own gate.
    const fly: RuntimeProvisioner = {
      ...fakeDockerProvisioner(),
      provider: "fly",
      manifest: { ...fakeDockerProvisioner().manifest, provider: "fly" },
    };
    registerProvisioner(fly);

    // Flag off → registered but refused, and never listed.
    expect(() => getProvisioner("fly")).toThrow("provider disabled: fly");
    expect(enabledProviders()).not.toContain("fly");

    process.env.ENABLE_FLY_PROVISIONING = "true";
    expect(getProvisioner("fly")).toBe(fly);
    expect(enabledProviders()).toContain("fly");
  });

  test("cloudflare keeps its historical flag name", () => {
    // ENABLE_CLOUDFLARE_SANDBOXES is set in the deployed hub. Deriving
    // ENABLE_CLOUDFLARE_PROVISIONING instead would have disabled Cloudflare
    // provisioning in production the moment this shipped.
    registerProvisioner(fakeCloudflareProvisioner());
    process.env.ENABLE_CLOUDFLARE_SANDBOXES = "true";
    expect(enabledProviders()).toContain("cloudflare");
  });

  test("even with its flag on, an unregistered name is refused", () => {
    // The contract no longer rejects unknown provider names, so this is the
    // check that stops one reaching a driver: nothing is registered as "fly",
    // so there is nothing to hand back, flag or no flag.
    process.env.ENABLE_FLY_PROVISIONING = "true";
    expect(() => getProvisioner("fly")).toThrow("provider not registered: fly");
  });
});

describe("getProvisioner — happy path", () => {
  test("register fake docker + flag on → returns the provisioner", () => {
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    const fake = fakeDockerProvisioner();
    registerProvisioner(fake);
    const got = getProvisioner("docker");
    expect(got).toBe(fake);
    expect(got.provider).toBe("docker");
  });

  test("register fake cloudflare + flag on → returns the provisioner", () => {
    process.env.ENABLE_CLOUDFLARE_SANDBOXES = "true";
    const fake = fakeCloudflareProvisioner();
    registerProvisioner(fake);
    const got = getProvisioner("cloudflare");
    expect(got).toBe(fake);
    expect(got.provider).toBe("cloudflare");
  });
});

describe("registerProvisioner", () => {
  test("re-registering a provider overwrites the previous instance", () => {
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    const first = fakeDockerProvisioner();
    const second = fakeDockerProvisioner();
    registerProvisioner(first);
    registerProvisioner(second);
    expect(getProvisioner("docker")).toBe(second);
  });
});

describe("resetProvisioners (test isolation)", () => {
  test("after reset, a previously registered provisioner is gone", () => {
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    registerProvisioner(fakeDockerProvisioner());
    resetProvisioners();
    expect(() => getProvisioner("docker")).toThrow("provider not registered: docker");
  });
});

// ─── Provider manifests ───────────────────────────────────────────────────────

describe("providerManifests", () => {
  it("serves each enabled provider's full manifest", () => {
    // The registry hands over what the driver declared, whole. The narrower
    // shape it replaces (`{provider, tiers}`) forced every new consumer —
    // console tier lists, conformance checks — to widen the registry first.
    process.env.ENABLE_DOCKER_PROVISIONING = "true";
    registerProvisioner(new DockerRuntimeProvisioner());
    const manifests = providerManifests();
    expect(manifests).toHaveLength(1);
    const m = manifests[0]!;
    expect(m.provider).toBe("docker");
    expect(m.supportedTiers).toEqual(["small", "medium", "large"]);
  });

  it("omits a registered provider whose env flag is off", () => {
    // Gating is the registry's job; a manifest served for a disabled provider
    // would put a choice in the console that createRuntime then refuses.
    registerProvisioner(fakeDockerProvisioner());
    expect(providerManifests()).toEqual([]);
  });
});
