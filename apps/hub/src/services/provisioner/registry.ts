/**
 * Fleet-era provisioner registry (P4 Task 4).
 *
 * Drivers register themselves here at wiring time (or in tests).
 * The registry gates access via environment flags so no driver instance
 * is ever returned for a disabled or unregistered provider.
 *
 * Which providers exist is decided by what is registered, not by a literal
 * list: `getProvisioner` refuses a name no driver ever registered. Whether a
 * registered provider may be used is decided by its env flag.
 *
 * Gating env vars:
 *   ENABLE_DOCKER_PROVISIONING=true   → "docker" is enabled
 *   ENABLE_CLOUDFLARE_SANDBOXES=true  → "cloudflare" is enabled
 *     (reuses the existing Cloudflare feature-flag name from config.ts)
 *   ENABLE_<PROVIDER>_PROVISIONING    → the rule every other driver gets
 */

import type { RuntimeProvisioner, RuntimeProviderName, DriverManifest } from "./types";

// ─── Internal registry map ────────────────────────────────────────────────────

let _registry = new Map<RuntimeProviderName, RuntimeProvisioner>();

// ─── Env-flag gating ──────────────────────────────────────────────────────────

/**
 * Env flag names that predate the derivation rule below.
 *
 * `ENABLE_CLOUDFLARE_SANDBOXES` is set in the deployed hub's environment and is
 * read by config.ts as well, so it cannot be renamed to fit a pattern without a
 * coordinated deploy that would silently disable provisioning if it were missed.
 * It is an override, not an alias: cloudflare is gated by this name and only
 * this name, so its behaviour is exactly what it was.
 *
 * Nothing may be added here for a *new* driver — a new driver gets its flag
 * from the rule, for free.
 */
const LEGACY_ENV_FLAGS: Record<string, string> = {
  cloudflare: "ENABLE_CLOUDFLARE_SANDBOXES",
};

/**
 * The env var that gates a provider.
 *
 * Derived from the provider name rather than switched on it: a `switch` over
 * provider names is a second hardcoded list of drivers, and the whole point of
 * the registry is that adding a driver edits the driver. A driver named "fly"
 * is gated by ENABLE_FLY_PROVISIONING with no edit here.
 */
export function providerEnvFlag(provider: string): string {
  return (
    LEGACY_ENV_FLAGS[provider] ??
    `ENABLE_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PROVISIONING`
  );
}

/**
 * Returns true if the given provider is enabled via its env flag.
 * Does NOT check whether a driver instance has been registered.
 *
 * A name nobody has ever heard of resolves to an env var nobody has ever set,
 * so it is false — which is what keeps `createRuntime` refusing an unregistered
 * provider now that the contract no longer carries an enum of names.
 */
export function isProviderEnabled(provider: RuntimeProviderName): boolean {
  return process.env[providerEnvFlag(provider)] === "true";
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

/**
 * What each enabled provider declares about itself, for the hub and the console
 * to build on.
 *
 * Exists so the console never offers a choice the driver will refuse. Cloudflare
 * fixes `instance_type` at worker deploy time and supports exactly one tier, so
 * a dialog offering small/medium/large produced a guaranteed provisioning
 * failure with a backend error as the only feedback.
 *
 * The declaration is read from the driver rather than hardcoded in the console:
 * a hardcoded map in the UI would silently rot the moment a worker is redeployed
 * at a different instance type.
 *
 * This serves the whole manifest, not the `{provider, tiers}` pair it replaces.
 * That narrower shape meant every new consumer — stop semantics, image binding,
 * idle behaviour — had to widen the registry before it could ask its question,
 * and there is no fallback here on purpose: `manifest` is required on every
 * driver, so defaulting could only ever mask a driver that failed to declare.
 */
export function providerManifests(): DriverManifest[] {
  return enabledProviders().map((provider) => _registry.get(provider)!.manifest);
}

/**
 * Retrieve the registered driver instance for a given provider name.
 *
 * A driver that registered itself is what makes a name real; there is no
 * literal set of known names to fall out of step with the drivers that exist.
 *
 * Throws:
 *   - `Error("provider not registered: X")` — flag is on but no driver registered.
 *   - `Error("provider disabled: X")`     — driver exists, env flag is off.
 *   - `Error("unknown provider: X")`      — no driver registered under that name.
 */
export function getProvisioner(provider: string): RuntimeProvisioner {
  const instance = _registry.get(provider);

  if (!instance) {
    // The flag being on says an operator meant to have this provider, so the
    // answer is "misconfigured deploy", not "no such thing" — that distinction
    // is the difference between wiring a driver and fixing a typo.
    if (isProviderEnabled(provider)) {
      throw new Error(`provider not registered: ${provider}`);
    }
    throw new Error(`unknown provider: ${provider}`);
  }

  if (!isProviderEnabled(provider)) {
    throw new Error(`provider disabled: ${provider}`);
  }

  return instance;
}

/**
 * Look up a registered provisioner WITHOUT the enabled-flag gate (for lifecycle
 * ops on already-created runtimes). Returns undefined if not registered.
 */
export function getProvisionerUnguarded(provider: string): RuntimeProvisioner | undefined {
  return _registry.get(provider);
}

// ─── Test helper ──────────────────────────────────────────────────────────────

/**
 * Clear the registry. Only use in test beforeEach/afterEach to ensure
 * test isolation — never call in production code.
 */
export function resetProvisioners(): void {
  _registry = new Map();
}
