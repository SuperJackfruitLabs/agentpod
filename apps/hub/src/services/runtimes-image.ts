/**
 * Which container image a harness runs on a given provider.
 *
 * Lifted out of runtimes.ts so it can be imported by BOOT-TIME code
 * (utils/validate-config.ts) without dragging in the database layer: the whole
 * point of the boot check is to run before anything else, and a config
 * validator that first opens a Postgres pool is a validator that cannot report
 * a bad config on a hub whose database is down. runtimes.ts re-exports
 * `imageForHarness`, so every existing importer is unaffected.
 *
 * Image resolution lives in the service layer so drivers stay image-agnostic —
 * they always receive the resolved image via ProvisionSpec.image and never read
 * env themselves.
 */

/**
 * The env-var infix for a harness: `""` for the generic node image,
 * `_OPENCODE`, `_PI`. Unknown harnesses resolve to the generic scope rather
 * than inventing a variable name nobody documents.
 */
function suffixFor(harness: string): string {
  return harness === "opencode" ? "_OPENCODE" : harness === "pi" ? "_PI" : "";
}

/** `modal` → `MODAL`; anything a provider name can legally contain is folded. */
function scopeFor(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * The provider-scoped variable that names this harness's image on this
 * provider — `NODE_AGENT_MODAL_PI_IMAGE`, `NODE_AGENT_FLY_OPENCODE_IMAGE`, …
 *
 * Exported so the boot check and the resolver cannot drift: a validator that
 * tells an operator to set a variable the resolver never reads is worse than no
 * validator, because the operator sets it and believes they are done.
 */
export function providerImageEnvVar(harness: string, provider: string): string {
  return `NODE_AGENT_${scopeFor(provider)}${suffixFor(harness)}_IMAGE`;
}

/** The un-scoped fallback: `NODE_AGENT_OPENCODE_IMAGE`, … */
export function harnessImageEnvVar(harness: string): string {
  return `NODE_AGENT${suffixFor(harness)}_IMAGE`;
}

/**
 * Can a substrate that PULLS its images do anything with this reference?
 *
 * Deliberately the same weak test the Modal driver applies before it creates a
 * sandbox (`spec.image.includes("/")`), and deliberately not tightened into
 * "the first segment must contain a dot or a colon": `rakeshgangwar/agentpod-node-modal:v1`
 * is a perfectly pullable Docker Hub reference, and a stricter rule would
 * refuse to boot a hub whose images are on Docker Hub. What it catches is the
 * one thing that is always wrong — a bare local tag such as
 * `agentpod-node-opencode:local`, which exists only in a developer's own Docker
 * daemon and gives a registry-pulling substrate nothing to fetch.
 */
export function isPullableFromRegistry(image: string): boolean {
  return image.includes("/");
}

/**
 * Resolve the container image for a harness on a given provider.
 *
 * It is provider-scoped because two enabled substrates need different
 * references for the same harness: Docker runs `agentpod-node-opencode:local`
 * from the host daemon, while Modal pulls from a registry and runs linux/amd64
 * only. One variable cannot serve both, and the failure mode when it tries is
 * silent — a sandbox that never boots, a runtime stuck in `provisioning`, and a
 * sweeper message two minutes later that names nothing.
 *
 * Resolution order, first non-empty hit wins:
 *   NODE_AGENT_<PROVIDER>_<HARNESS>_IMAGE   e.g. NODE_AGENT_MODAL_OPENCODE_IMAGE
 *   NODE_AGENT_<HARNESS>_IMAGE              e.g. NODE_AGENT_OPENCODE_IMAGE
 *   the built-in local default
 *
 * With no provider-scoped variable set, this resolves exactly what it resolved
 * before — Docker and Cloudflare are unchanged, which is checked against the
 * documented variable names in runtimes-image.test.ts.
 *
 * The provider-scoped name is not free-form: `NODE_AGENT_MODAL_IMAGE` is the
 * same variable `config.ts` reads and `validate-config.ts` refuses to boot
 * without. The two must stay in step, or an operator satisfies the boot check
 * and Modal is still handed a tag it cannot pull.
 */
export function imageForHarness(harness: string, provider: string): string {
  const suffix = suffixFor(harness);
  const fallback =
    suffix === "_OPENCODE"
      ? "agentpod-node-opencode:local"
      : suffix === "_PI"
        ? "agentpod-node-pi:local"
        : "agentpod-node:local";

  return (
    process.env[providerImageEnvVar(harness, provider)] ||
    process.env[harnessImageEnvVar(harness)] ||
    fallback
  );
}
