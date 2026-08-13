/**
 * Provisioner credential resolution (P4 Task 8).
 *
 * ## Why the hub may hold these secrets at all
 *
 * The standing rule is that the hub holds nothing that can reach the existing
 * fleet: enrolment is outbound-dialled by each node-agent, and SSH runs from
 * the operator's local agent, never from the hub. A Fly or Modal API token is
 * **a different property**, not an exception to that rule. Such a token creates
 * *new* infrastructure — it cannot open a session on, read from, or command any
 * enrolled node. Read this before concluding the rule was broken here.
 *
 * ## Why an interface rather than `process.env` at the call site
 *
 * Credentials are env-based today, behind `CredentialResolver`, so the per-org
 * encrypted store planned with the orgs work (Horizon 3) can land by replacing
 * the implementation — no driver changes, no call-site changes.
 *
 * ## Why the error lists every missing key
 *
 * A missing key is a startup-time refusal to register a driver, not a runtime
 * failure on a user's first provisioning attempt. Reporting one key at a time
 * would cost an operator one redeploy per key; the whole set is collected so a
 * misconfigured deploy is fixed in a single pass.
 *
 * Note the deliberate omission: Docker and Cloudflare are **not** wired through
 * this module. They read env directly today and rerouting them would change
 * behaviour, not structure. This is the seam the new drivers will use.
 */

/**
 * Source of provisioner credentials by key.
 *
 * `get` returns `undefined` for a key this deployment has not configured.
 * Implementations must read their backing store at call time, not snapshot it
 * at construction — the hub builds resolvers during module init, before some
 * configuration is necessarily in place.
 */
export interface CredentialResolver {
  get(key: string): string | undefined;
}

/** Credential resolver backed by `process.env`. */
export function envCredentialResolver(): CredentialResolver {
  return {
    get: (key) => process.env[key],
  };
}

/**
 * Resolve every key a driver declares, or throw naming the provider and *all*
 * of the missing keys.
 *
 * An empty string counts as missing: deploy platforms commonly surface an unset
 * secret as `""`, and handing a driver a blank token only moves the failure to
 * the first API call, where it reads as an auth problem rather than a
 * configuration one.
 *
 * Generic over the key literals so the return type has *declared* properties.
 * The obvious `Record<string, string>` is an index signature, and the hub
 * compiles with `noUncheckedIndexedAccess`, so `const { FLY_API_TOKEN } =
 * requireCredentials(...)` widened to `string | undefined` at the first real
 * call site — a driver forced to write `!` on a value this function has already
 * thrown over is being told to distrust the guarantee it just bought.
 */
export function requireCredentials<K extends string>(
  provider: string,
  keys: readonly K[],
  resolver: CredentialResolver
): Record<K, string> {
  const resolved = {} as Record<K, string>;
  const missing: string[] = [];

  for (const key of keys) {
    const value = resolver.get(key);
    if (value === undefined || value === "") {
      missing.push(key);
      continue;
    }
    resolved[key] = value;
  }

  if (missing.length > 0) {
    throw new Error(
      `provisioner "${provider}" is missing required credentials: ${missing.join(
        ", "
      )}`
    );
  }

  return resolved;
}
