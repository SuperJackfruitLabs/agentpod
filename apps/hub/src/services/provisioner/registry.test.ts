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

const ENV_KEYS = ["ENABLE_DOCKER_PROVISIONING", "ENABLE_CLOUDFLARE_SANDBOXES"];

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  resetProvisioners();
  saveEnv(...ENV_KEYS);
  // Start with both flags off
  delete process.env.ENABLE_DOCKER_PROVISIONING;
  delete process.env.ENABLE_CLOUDFLARE_SANDBOXES;
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

  test("known provider (docker) but flag off → throws 'provider disabled: docker'", () => {
    // Flag is unset (both deleted in beforeEach)
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
