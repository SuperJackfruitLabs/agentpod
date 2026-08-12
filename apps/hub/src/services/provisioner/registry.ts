/**
 * Fleet-era provisioner registry (P4 Task 4).
 *
 * Drivers register themselves here at wiring time (or in tests).
 * The registry gates access via environment flags so no driver instance
 * is ever returned for a disabled or unregistered provider.
 *
 * Gating env vars:
 *   ENABLE_DOCKER_PROVISIONING=true   → "docker" is enabled
 *   ENABLE_CLOUDFLARE_SANDBOXES=true  → "cloudflare" is enabled
 *     (reuses the existing Cloudflare feature-flag name from config.ts)
 */

import type { RuntimeProvisioner, RuntimeProviderName, ResourceTier } from "./types";

// ─── Known provider names (type-checked set) ──────────────────────────────────

const KNOWN_PROVIDERS = new Set<RuntimeProviderName>(["docker", "cloudflare"]);

// ─── Internal registry map ────────────────────────────────────────────────────

let _registry = new Map<RuntimeProviderName, RuntimeProvisioner>();

// ─── Env-flag gating ──────────────────────────────────────────────────────────

/**
 * Returns true if the given provider is enabled via its env flag.
 * Does NOT check whether a driver instance has been registered.
 */
export function isProviderEnabled(provider: RuntimeProviderName): boolean {
  switch (provider) {
    case "docker":
      return process.env.ENABLE_DOCKER_PROVISIONING === "true";
    case "cloudflare":
      return process.env.ENABLE_CLOUDFLARE_SANDBOXES === "true";
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a driver instance. Call this at app wiring time or in test setup.
 * Re-registering the same provider name overwrites the previous instance.
 */
export function registerProvisioner(p: RuntimeProvisioner): void {
  _registry.set(p.provider, p);
}

/**
 * Returns the list of providers that are both registered AND enabled via
 * their env flag. Used by service-level code to advertise available providers.
 */
export function enabledProviders(): RuntimeProviderName[] {
  const result: RuntimeProviderName[] = [];
  for (const [provider] of _registry) {
    if (isProviderEnabled(provider)) {
      result.push(provider);
    }
  }
  return result;
}

/** Every tier, for a driver that does not restrict them. */
const ALL_TIERS: ResourceTier[] = ["small", "medium", "large"];

/**
 * What each enabled provider can actually do, for the UI to build its form from.
 *
 * Exists so the console never offers a choice the driver will refuse. Cloudflare
 * fixes `instance_type` at worker deploy time and supports exactly one tier, so
 * a dialog offering small/medium/large produced a guaranteed provisioning
 * failure with a backend error as the only feedback.
 *
 * The capability is read from the driver rather than hardcoded in the console:
 * a hardcoded map in the UI would silently rot the moment a worker is redeployed
 * at a different instance type.
 */
export function providerCapabilities(): Array<{
  provider: RuntimeProviderName;
  tiers: ResourceTier[];
}> {
  return enabledProviders().map((provider) => {
    const driver = _registry.get(provider);
    return { provider, tiers: driver?.supportedTiers ?? ALL_TIERS };
  });
}

/**
 * Retrieve the registered driver instance for a given provider name.
 *
 * Throws:
 *   - `Error("unknown provider: X")`      — X is not a recognised name.
 *   - `Error("provider disabled: X")`     — env flag is off.
 *   - `Error("provider not registered: X")` — flag is on but no driver registered.
 */
export function getProvisioner(provider: string): RuntimeProvisioner {
  if (!KNOWN_PROVIDERS.has(provider as RuntimeProviderName)) {
    throw new Error(`unknown provider: ${provider}`);
  }

  const name = provider as RuntimeProviderName;

  if (!isProviderEnabled(name)) {
    throw new Error(`provider disabled: ${provider}`);
  }

  const instance = _registry.get(name);
  if (!instance) {
    throw new Error(`provider not registered: ${provider}`);
  }

  return instance;
}

/**
 * Look up a registered provisioner WITHOUT the enabled-flag gate (for lifecycle
 * ops on already-created runtimes). Returns undefined if not registered.
 */
export function getProvisionerUnguarded(provider: string): RuntimeProvisioner | undefined {
  return _registry.get(provider as RuntimeProviderName);
}

// ─── Test helper ──────────────────────────────────────────────────────────────

/**
 * Clear the registry. Only use in test beforeEach/afterEach to ensure
 * test isolation — never call in production code.
 */
export function resetProvisioners(): void {
  _registry = new Map();
}
