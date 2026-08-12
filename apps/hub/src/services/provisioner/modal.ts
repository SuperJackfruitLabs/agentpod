/**
 * Modal sandbox provisioner driver.
 *
 * A Modal runtime is A ROLLING SERIES OF SANDBOXES ANCHORED BY A NAMED VOLUME.
 * That sentence is the design. Modal has no stop/start — `terminate` is
 * irreversible — and every sandbox is destroyed by the platform at 24 hours
 * whatever it is doing, so the sandbox cannot be the thing that persists. The
 * Volume is: it is named after the AgentPod runtime id, so a brand-new sandbox
 * finds the previous one's workspace by name (measured 2026-08-13; without this
 * fact Modal would not be usable at all).
 *
 * What is NOT in the Volume, on purpose: credentials. HOME stays on the
 * disposable rootfs, so the node-agent's config.json — node id and node secret
 * — dies with each sandbox, and every new sandbox enrols with a freshly minted
 * runtime-bound token. Nothing has to protect a secret at rest in shared storage
 * because nothing puts one there.
 *
 * SECURITY: spec.enrollToken is passed in the sandbox env and is never logged by
 * this module. Do not add a log statement that references it.
 */

import type {
  DriverManifest,
  ProvisionSpec,
  ResourceTier,
  RuntimeProvisioner,
  RuntimeState,
} from "./types";
import type { ModalApi } from "./modal-api";

/**
 * Modal's hard ceiling on a sandbox's life. Not configurable by us.
 *
 * Measured 2026-08-13 against a real Modal account — every number and verb in
 * the manifest below came from that probe rather than from Modal's docs, and
 * the date is here because this repo has repeatedly been bitten by declarations
 * written from documentation. What the probe established:
 *
 *   - The first-party JS SDK runs on Bun: client constructed, credentials
 *     resolved from ~/.modal.toml, sandbox created, volume mounted, `exec` run,
 *     sandbox terminated. No Python shim is needed; this driver is ordinary
 *     TypeScript.
 *   - A named Volume DOES anchor identity across sandbox recreation. Sandbox 1
 *     wrote a sentinel into a volume-mounted path and terminated; sandbox 2 —
 *     a DIFFERENT sandboxId — mounted the same Volume by name and read the
 *     sentinel back. This single fact is what makes Modal viable at all, and it
 *     is why the durable half of the external id is the volume name.
 *   - `terminate` is irreversible and there is no start verb. Every restart is
 *     a new sandbox with a new id and a fresh rootfs → stopSemantics
 *     "terminal", and conformance rule 3 forbids a start() on this class.
 *   - Hard 24-hour maximum sandbox lifetime. The platform destroys a HEALTHY
 *     sandbox on that deadline, never brings it back, and gives no warning
 *     callback. Nothing in the API rotates for you → maxLifetimeMs below.
 *   - `idleTimeoutMs` is opt-in and defaults to OFF. Never set it. That
 *     sidesteps the Cloudflare-style inbound-activity trap entirely: a
 *     node-agent dials out and receives nothing, so an inbound-keyed idle timer
 *     reaps a busy station → idleBehaviour "never".
 *   - `timeoutMs` defaults to FIVE MINUTES. Not setting it is not "no limit",
 *     it is "your station dies in five minutes" → provision() always sets it.
 *   - Image and CPU/memory are both per-sandbox → imageBinding "per-instance"
 *     and all three tiers.
 *   - The SDK is 0.x and churns: `timeout` was renamed `timeoutMs` and an
 *     unknown key is REJECTED at runtime by the SDK's own checkForRenamedParams
 *     guard. Pin the version exactly; keep the SDK behind ./modal-api.
 */
export const MODAL_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Where the anchoring Volume is mounted. The workspace, and only that.
 *
 * Deliberately not HOME: the node-agent writes its node id and node secret to
 * $HOME/.config/agentpod-node/, and those must die with each sandbox so no
 * credential is ever left at rest in shared storage. The 24-hour ceiling then
 * degrades from data loss to daily re-enrolment churn.
 */
export const MODAL_WORKSPACE_PATH = "/workspace";

/**
 * Tier → sandbox sizing, matching the Docker driver's limits so "medium" means
 * the same thing to a user whichever substrate they picked.
 */
export const MODAL_RESOURCE_TIERS: Record<ResourceTier, { cpu: number; memoryMiB: number }> = {
  small: { cpu: 0.5, memoryMiB: 1024 },
  medium: { cpu: 1, memoryMiB: 2048 },
  large: { cpu: 2, memoryMiB: 4096 },
};

/** Separator for the composite external id. Legal in neither half. */
const EXTERNAL_ID_SEPARATOR = "#";

/** Longest slug we take from a runtime id, before the "agentpod-" prefix. */
const VOLUME_SLUG_MAX_LENGTH = 50;

/**
 * The durable name for a runtime's Volume.
 *
 * Derived from the runtime id rather than stored anywhere, so provisioning again
 * for the same runtime re-attaches the same workspace with no extra bookkeeping
 * — that is what makes "start" implementable on a substrate with no start verb.
 */
export function volumeNameFor(runtimeId: string): string {
  const slug = runtimeId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, VOLUME_SLUG_MAX_LENGTH)
    // Trimmed a second time because the truncation above can land mid-separator
    // and leave a trailing dash. Only ids longer than the limit reach this, so
    // it is exactly the case no ordinary test would produce.
    .replace(/-+$/g, "");
  if (!slug) {
    throw new Error(
      `modal: cannot derive a volume name from runtime id "${runtimeId}"`
    );
  }
  return `agentpod-${slug}`;
}

/**
 * The hub stores ONE string per runtime, and this driver needs two identifiers:
 * the Volume that persists and the sandbox that does not. Encoding both is what
 * lets a stateless driver, on a fresh hub process, destroy the right volume for
 * a sandbox it has never seen.
 */
export function encodeExternalId(volumeName: string, sandboxId: string): string {
  return `${volumeName}${EXTERNAL_ID_SEPARATOR}${sandboxId}`;
}

/**
 * Split a composite external id, or throw.
 *
 * THROWING IS THE POINT. A half — an empty volume name, an empty sandbox id, a
 * bare id with no separator — must never be handed onward as if it addressed
 * something. The Fly driver shipped a codec that let an empty half through: it
 * built a URL addressing nothing, and the 404 that came back was read by the
 * destroy path as "already gone", which silently leaked a machine and its
 * volume while reporting success. Every rejection names the id, because an
 * unattributed refusal is indistinguishable from a substrate that is down.
 */
export function decodeExternalId(externalId: string): {
  volumeName: string;
  sandboxId: string;
} {
  const [volumeName, sandboxId, ...rest] = String(externalId).split(
    EXTERNAL_ID_SEPARATOR
  );
  if (!volumeName || !sandboxId || rest.length > 0) {
    throw new Error(
      `modal: malformed external id "${externalId}" — expected ` +
        `"<volume>${EXTERNAL_ID_SEPARATOR}<sandbox>"`
    );
  }
  return { volumeName, sandboxId };
}

export interface ModalProvisionerOptions {
  /** The substrate. Injected so tests and the conformance suite never call Modal. */
  api: ModalApi;
  /** Modal App the sandboxes are grouped under. Grouping only. */
  appName?: string;
  /**
   * Override for the platform ceiling, clamped to MODAL_MAX_LIFETIME_MS.
   *
   * Two honest uses: verifying rotation in ten minutes rather than a day, and
   * absorbing a future change to Modal's ceiling without a release. It can only
   * ever shorten — a longer timeoutMs is rejected by Modal outright.
   */
  maxLifetimeMs?: number;
}

export class ModalRuntimeProvisioner implements RuntimeProvisioner {
  readonly provider = "modal" as const;
  readonly supportedTiers: ResourceTier[] = ["small", "medium", "large"];
  readonly manifest: DriverManifest;

  private readonly api: ModalApi;
  private readonly appName: string;
  private readonly maxLifetimeMs: number;

  constructor({ api, appName, maxLifetimeMs }: ModalProvisionerOptions) {
    this.api = api;
    this.appName = appName ?? process.env.MODAL_APP_NAME ?? "agentpod";
    // Parenthesised because `??` may not be mixed with `||` unparenthesised —
    // it is a SyntaxError, not a precedence surprise. Number(undefined) is NaN
    // and NaN is falsy, so an unset or unparseable env var falls through to the
    // platform ceiling rather than clamping to NaN.
    const requested =
      maxLifetimeMs ??
      (Number(process.env.MODAL_MAX_LIFETIME_MS) || MODAL_MAX_LIFETIME_MS);
    this.maxLifetimeMs = Math.min(requested, MODAL_MAX_LIFETIME_MS);

    this.manifest = {
      provider: "modal",
      // The rootfs is thrown away on every recreation and there are a lot of
      // recreations; the named Volume is the only thing that persists.
      workspaceStorage: "volume",
      // terminate() is irreversible and there is no start verb. Conformance
      // rule 3 turns this into a check that no start() exists on this class.
      stopSemantics: "terminal",
      // Measured: the platform destroys a healthy sandbox at this age, silently
      // and permanently. sweepExpiringRuntimes() rotates before it happens.
      maxLifetimeMs: this.maxLifetimeMs,
      // Modal pulls the registry reference per sandbox, so spec.image is real.
      imageBinding: "per-instance",
      supportedTiers: this.supportedTiers,
      // idleTimeoutMs is opt-in and we never set it, so nothing here mistakes an
      // outbound-only node-agent for an idle one.
      idleBehaviour: "never",
      // No "start": there is nothing to start. The hub restarts a terminal
      // runtime by provisioning again against the same Volume.
      lifecycle: ["stop", "status"],
    };
  }

  async provision(
    _spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    throw new Error("modal: provision is implemented in Task 3");
  }

  async destroy(_externalId: string): Promise<void> {
    throw new Error("modal: destroy is implemented in Task 5");
  }

  async stop(_externalId: string): Promise<void> {
    throw new Error("modal: stop is implemented in Task 4");
  }

  async status(_externalId: string): Promise<RuntimeState> {
    throw new Error("modal: status is implemented in Task 4");
  }
}
