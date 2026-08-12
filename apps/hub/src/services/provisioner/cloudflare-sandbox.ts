/**
 * Cloudflare Sandbox provisioner driver.
 *
 * Talks to `cloudflare/worker-v2/`, which runs a container carrying a released
 * agentpod-node. The container dials the hub outbound and enrols itself, so this
 * driver's only job is lifecycle.
 *
 * Replaced the dead OpenCode-era driver `cloudflare.ts`, deleted 2026-08-12 when
 * the manifest became required and there was nothing true to declare for a
 * driver that had never provisioned anything. The lesson carried over from it:
 * **every response is validated**. That driver documented an
 * ASSUMPTION about the worker's contract and never checked it, so a 2xx with the
 * wrong body would have produced a runtime stuck in `provisioning` with no error
 * logged anywhere.
 *
 * SECURITY: the enrolment token is sent in the request body and is never logged
 * by this module. Do not add log statements that reference spec.enrollToken.
 */

import type {
  RuntimeProvisioner,
  ProvisionSpec,
  ResourceTier,
  RuntimeState,
  DriverManifest,
} from "./types";

export interface CloudflareSandboxOptions {
  workerUrl?: string;
  apiToken?: string;
  /**
   * The image the worker was deployed with. Cloudflare bakes it at deploy time,
   * so a spec asking for anything else cannot be satisfied and is refused.
   */
  deployedImage?: string;
  /**
   * Shared secret the container presents when telling the hub it slept. Without
   * it the hub cannot distinguish a routine sleep from a dead container.
   */
  callbackToken?: string;
  /**
   * The resource tier the deployed worker actually provides. Cloudflare fixes
   * `instance_type` per container class, so one deployment offers exactly one
   * tier; anything else cannot be honoured and is refused rather than ignored.
   */
  deployedTier?: string;
  /** Injectable fetch — used to inject a fake in unit tests. */
  fetchImpl?: typeof globalThis.fetch;
}

export class CloudflareSandboxProvisioner implements RuntimeProvisioner {
  readonly provider = "cloudflare" as const;

  /**
   * Exactly one tier: Cloudflare fixes instance_type per container class, so
   * this worker provides the tier it was deployed with and nothing else. The
   * console reads this to build its form, which is why provisioning can no
   * longer be offered in a shape this driver would refuse.
   */
  readonly supportedTiers: ResourceTier[];

  /**
   * Everything below is something this driver already enforces by hand; the
   * manifest only says it out loud, where the hub can read it before a
   * provision rather than after an incident.
   *
   * Assigned in the constructor, not as a field initialiser, because
   * `supportedTiers` is not knowable until `deployedTier` is.
   */
  readonly manifest: DriverManifest;

  private readonly workerUrl: string;
  private readonly apiToken: string;
  private readonly deployedImage: string;
  private readonly callbackToken: string;
  private readonly deployedTier: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor({
    workerUrl = process.env.CLOUDFLARE_WORKER_URL ?? "",
    apiToken = process.env.CLOUDFLARE_WORKER_TOKEN ?? "",
    deployedImage = process.env.CLOUDFLARE_SANDBOX_IMAGE ?? "",
    callbackToken = process.env.RUNTIME_CALLBACK_TOKEN ?? "",
    // standard-1 is 4 GiB, which is the Docker "large" tier's memory limit.
    deployedTier = process.env.CLOUDFLARE_INSTANCE_TIER ?? "large",
    fetchImpl = globalThis.fetch,
  }: CloudflareSandboxOptions = {}) {
    this.workerUrl = workerUrl.replace(/\/$/, "");
    this.apiToken = apiToken;
    this.deployedImage = deployedImage;
    this.callbackToken = callbackToken;
    this.deployedTier = deployedTier;
    this.supportedTiers = [deployedTier as ResourceTier];
    this.fetchImpl = fetchImpl;

    this.manifest = {
      provider: "cloudflare",
      // The container disk does NOT survive a sleep. The workspace lives only
      // because `snapshot-wrapper.sh` archives it to R2 on SIGTERM and restores
      // it on boot. This field is the one the interface could not previously
      // express, and its absence is what cost a user their work: a driver whose
      // rootfs is wiped looked identical to Docker's, whose rootfs is not.
      workspaceStorage: "external-archive",
      // start() and stop() below map to real worker routes and the same sandbox
      // id comes back afterwards. "resumable" is about the INSTANCE, not the
      // disk — the disk is covered by workspaceStorage above, and the two
      // differ here precisely because the R2 archive is what bridges them.
      stopSemantics: "resumable",
      // Cloudflare imposes no ceiling on how long a sandbox may exist; what it
      // imposes is the idle timer, declared below. A container that keeps being
      // touched is never destroyed for age.
      maxLifetimeMs: null,
      // wrangler.toml bakes `image` into the worker at deploy time, so
      // spec.image cannot be honoured per instance — provision() refuses a
      // differing image rather than quietly booting the wrong harness.
      imageBinding: "fixed",
      // Derived, never hardcoded: provision() refuses any tier but
      // `deployedTier`, so advertising a constant here would let the console
      // offer a tier this driver then rejects the moment a worker is redeployed
      // at a different instance type.
      supportedTiers: this.supportedTiers,
      // `sleepAfter = "15m"` in the worker, and its timer counts INBOUND
      // requests only. A node-agent dials out and receives nothing, so a busy
      // station reads as idle — which is how a live station vanished
      // mid-session on 2026-08-12. touch() exists solely to keep pushing this
      // deadline out; the trap is the substrate's, not ours.
      idleBehaviour: "platform-inbound",
      // All three are implemented below. status() in particular is what lets
      // the hub write `stopped` on evidence — but only against a worker
      // deployed with the state-reporting GET /sandbox/:id.
      lifecycle: ["start", "stop", "status"],
    };
  }

  private async call(
    path: string,
    init: RequestInit
  ): Promise<Record<string, unknown>> {
    if (!this.workerUrl) {
      throw new Error(
        "cloudflare: CLOUDFLARE_WORKER_URL is not set; cannot reach the sandbox worker"
      );
    }

    const res = await this.fetchImpl(`${this.workerUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      throw new Error(`cloudflare: worker returned ${res.status} for ${path}`);
    }

    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`cloudflare: unexpected response from ${path} (not JSON)`);
    }
  }

  async provision(
    spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    // Cloudflare bakes the image at worker deploy time. Honour-or-refuse, never
    // ignore: a driver that quietly drops an input is how the previous one would
    // have failed.
    if (this.deployedImage && spec.image !== this.deployedImage) {
      throw new Error(
        `cloudflare: this worker is deployed with image "${this.deployedImage}" and ` +
          `cannot provision "${spec.image}". Cloudflare bakes the image at deploy ` +
          `time; redeploy the worker to change it.`
      );
    }

    // Same rule as the image, for the same reason. Cloudflare fixes
    // instance_type per container class, so a tier this worker was not deployed
    // with cannot be satisfied. Until per-tier container classes exist, this
    // driver refuses rather than quietly handing out a size nobody asked for.
    if (this.deployedTier && spec.resourceTier !== this.deployedTier) {
      throw new Error(
        `cloudflare: this worker provides the "${this.deployedTier}" resource tier ` +
          `and cannot provision "${spec.resourceTier}". Cloudflare fixes the ` +
          `instance type at worker deploy time; choose "${this.deployedTier}" or ` +
          `deploy a worker for the tier you want.`
      );
    }

    const body = await this.call("/sandbox", {
      method: "POST",
      body: JSON.stringify({
        id: spec.runtimeId,
        hubUrl: spec.hubUrl,
        enrollToken: spec.enrollToken,
        callbackToken: this.callbackToken,
      }),
    });

    const sandboxId = body.sandboxId;
    if (typeof sandboxId !== "string" || !sandboxId) {
      throw new Error(
        "cloudflare: unexpected response from /sandbox (no sandboxId)"
      );
    }

    return { externalId: sandboxId, runtime: "cloudflare-container" };
  }

  async destroy(externalId: string): Promise<void> {
    await this.call(`/sandbox/${externalId}`, { method: "DELETE" });
  }

  /** Also the wake path: to the worker a wake IS a start. */
  async start(externalId: string): Promise<void> {
    await this.call(`/sandbox/${externalId}/start`, { method: "POST" });
  }

  async stop(externalId: string): Promise<void> {
    await this.call(`/sandbox/${externalId}/stop`, { method: "POST" });
  }

  /**
   * Ask the worker whether this sandbox's container is actually running.
   *
   * The evidence behind a `stopped` runtime on this substrate. Cloudflare's
   * stop() returns as soon as the container is signalled — the exit lands
   * later, after the container has archived its workspace on SIGTERM — so this
   * is what eventually confirms the stop, via the hub's sweeper.
   *
   * **Requires a worker deployed with the state-reporting GET /sandbox/:id.**
   * An older deployment answers `{sandboxId}` with no `state`, and that reads
   * as `unknown` — never as `stopped`. Treating a missing field as "it stopped"
   * would recreate the very bug this exists to fix, on nothing more than an
   * un-redeployed worker. Unknown is safe: the hub keeps asking and, if the
   * answer never comes, says the stop was not confirmed instead of pretending.
   */
  async status(externalId: string): Promise<RuntimeState> {
    const body = await this.call(`/sandbox/${externalId}`, { method: "GET" });
    const state = body.state;
    return state === "running" || state === "stopped" ? state : "unknown";
  }

  /**
   * Push the substrate's idle deadline out because this station is in use.
   *
   * Cloudflare's timer counts only incoming requests and a node-agent dials out,
   * so without this a station sleeps 15 minutes after start however busy it is.
   */
  async touch(externalId: string): Promise<void> {
    await this.call(`/sandbox/${externalId}/touch`, { method: "POST" });
  }
}
