/**
 * Cloudflare runtime provisioner driver — **DEAD as of 2026-08-12.**
 *
 * This driver has never provisioned a working fleet runtime and cannot: the
 * worker it targets (`cloudflare/worker/`, see its DEAD.md) is OpenCode-era and
 * ignores both `image` and `env`, so the enrolment token never reaches the
 * container and the container has no `agentpod-node` binary to use it.
 *
 * **The dangerous part is that it would look like it worked.** The worker's
 * routes match what the ASSUMPTION block below describes, so a provision
 * returns 2xx, this driver reports success and persists an externalId, and the
 * runtime row then sits in `provisioning` forever with no error logged
 * anywhere. That is the same silent-success failure as #243.
 *
 * It is left in place, still unregistered (`ENABLE_CLOUDFLARE_SANDBOXES` is
 * unset everywhere), because its tests pin the RuntimeProvisioner interface for
 * a non-Docker provider. Do not enable it. A replacement built on the modern
 * `@cloudflare/sandbox` SDK is tracked separately.
 *
 * ── Original header, preserved because the ASSUMPTION is exactly what went
 *    wrong: the routes were verified, the semantics never were ───────────────
 *
 * Cloudflare runtime provisioner driver (P4 Task 6).
 *
 * Creates and destroys node-agent sandboxes via the Cloudflare Worker REST API.
 * Sandboxes are ephemeral — start/stop are intentionally omitted.
 *
 * The worker-fetch pattern mirrors apps/hub/src/services/providers/cloudflare-provider.ts:
 *   url  = ${workerUrl}${path}
 *   auth = Authorization: Bearer ${apiToken}
 *
 * ASSUMPTION: The CF worker's POST /sandbox endpoint accepts a body of the form
 *   { id, image, env: { AGENTPOD_HUB_URL, AGENTPOD_ENROLL_TOKEN } }
 * and responds with { sandboxId?: string, id?: string, ... } (success is inferred
 * from HTTP 2xx; externalId = response.sandboxId ?? response.id ?? spec.runtimeId).
 *
 * SECURITY: the enrollment token is written into the request body but is never
 * logged by this module. Do not add log statements that reference spec.enrollToken.
 */

import type { RuntimeProvisioner, ProvisionSpec } from "./types";

// ─── Worker response shape ────────────────────────────────────────────────────

interface WorkerCreateResponse {
  success?: boolean;
  error?: string;
  /** The worker may echo the sandbox id under several keys. */
  sandboxId?: string;
  id?: string;
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export interface CloudflareRuntimeProvisionerOptions {
  workerUrl?: string;
  apiToken?: string;
  /** Injectable fetch implementation — defaults to globalThis.fetch.  Used to
   *  inject a fake in unit tests without touching real Cloudflare. */
  fetchImpl?: typeof globalThis.fetch;
}

export class CloudflareRuntimeProvisioner implements RuntimeProvisioner {
  readonly provider = "cloudflare" as const;

  private readonly workerUrl: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor({
    workerUrl = process.env.CLOUDFLARE_WORKER_URL ?? "",
    apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "",
    fetchImpl = globalThis.fetch,
  }: CloudflareRuntimeProvisionerOptions = {}) {
    this.workerUrl = workerUrl;
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
  }

  // ─── Internal helper ──────────────────────────────────────────────────────

  /** Mirrors CloudflareSandboxProvider.workerFetch — builds URL + adds auth. */
  private async workerFetch(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const url = `${this.workerUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const response = await this.fetchImpl(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cloudflare Worker error: ${response.status} - ${error}`);
    }

    return response;
  }

  // ─── RuntimeProvisioner ───────────────────────────────────────────────────

  /**
   * Create a new sandbox running the node-agent image.
   *
   * Body sent to POST /sandbox:
   *   { id: runtimeId, image, env: { AGENTPOD_HUB_URL, AGENTPOD_ENROLL_TOKEN } }
   *
   * Image comes from spec.image — resolved by the service layer (imageForHarness).
   * This driver is intentionally image-agnostic.
   *
   * NOTE: enrollToken is in the request body (as required to boot the node-agent)
   * but this method never logs it.
   */
  async provision(spec: ProvisionSpec): Promise<{ externalId: string }> {
    const image = spec.image;

    const response = await this.workerFetch("/sandbox", {
      method: "POST",
      body: JSON.stringify({
        id: spec.runtimeId,
        image,
        env: {
          AGENTPOD_HUB_URL: spec.hubUrl,
          // NOTE: this is intentionally in the body so the sandbox can self-enroll.
          // Do NOT add any log statement below that references spec.enrollToken.
          AGENTPOD_ENROLL_TOKEN: spec.enrollToken,
        },
      }),
    });

    const result = (await response.json()) as WorkerCreateResponse;

    // The worker may echo back the sandbox id under different keys.
    // Fall back to spec.runtimeId (the id we told the worker to use) if absent.
    const externalId = result.sandboxId ?? result.id ?? spec.runtimeId;

    return { externalId };
  }

  /**
   * Permanently delete the sandbox identified by externalId.
   */
  async destroy(externalId: string): Promise<void> {
    await this.workerFetch(`/sandbox/${externalId}`, {
      method: "DELETE",
    });
  }

  // start / stop intentionally omitted — CF sandboxes are ephemeral.
}
