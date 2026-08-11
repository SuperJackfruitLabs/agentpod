/**
 * Docker runtime provisioner driver (P4 Task 5).
 *
 * Creates and manages node-agent containers via the DockerOrchestrator.
 * The container is started with AGENTPOD_HUB_URL and AGENTPOD_ENROLL_TOKEN
 * injected so the node-agent can auto-enroll into the fleet.
 *
 * SECURITY: the enrollment token is written into the container env but is
 * never logged by this module.
 */

import type { RuntimeProvisioner, ProvisionSpec } from "./types";
import { DockerOrchestrator } from "./docker-orchestrator";
import type { ResourceLimits } from "./docker-orchestrator";

// ─── Resource tier mapping ────────────────────────────────────────────────────

/**
 * Maps P4 resource tier names (small/medium/large) to Docker resource limits.
 * Mirrors the existing getResourcesForTier approach in docker-provider.ts.
 */
const RUNTIME_RESOURCE_TIERS: Record<
  "small" | "medium" | "large",
  ResourceLimits
> = {
  // small was 512m; a live opencode runtime OOM-killed its acp session at
  // 513MB rss (memcg, 2026-08-09) — `opencode serve` + one `opencode acp`
  // need ≥1g to coexist.
  small:  { cpus: "0.5", memory: "1g",    pidsLimit: 100 },
  medium: { cpus: "1.0", memory: "2g",    pidsLimit: 256 },
  large:  { cpus: "2.0", memory: "4g",    pidsLimit: 512 },
};

// ─── Driver ───────────────────────────────────────────────────────────────────

export class DockerRuntimeProvisioner implements RuntimeProvisioner {
  readonly provider = "docker" as const;

  /**
   * @param orchestrator Injected for testing; defaults to a real DockerOrchestrator
   *   (no-arg constructor uses socket defaults from DockerOrchestratorConfig).
   */
  constructor(
    private readonly orchestrator: DockerOrchestrator = new DockerOrchestrator({
      // Set by the operator to harden the host, e.g. DOCKER_RUNTIME=runsc for
      // gVisor. Unset keeps Docker's default and today's exact behaviour.
      runtime: process.env.DOCKER_RUNTIME || "",
    })
  ) {}

  /**
   * Create and start a node-agent container.
   *
   * Image comes from spec.image — resolved by the service layer via
   * imageForHarness() before calling the driver.  Drivers are intentionally
   * image-agnostic: they never read NODE_AGENT_IMAGE themselves.
   *
   * Returns spec.runtimeId as externalId because the orchestrator's lifecycle
   * methods (startSandbox / stopSandbox / deleteSandbox) resolve containers by
   * the sandbox config.id (name: "agentpod-<id>" or label agentpod.sandbox.id),
   * NOT by the raw hex Docker container id.
   *
   * Also returns the runtime the daemon reports for the container — observed
   * via inspect, not the one requested via DOCKER_RUNTIME.
   */
  async provision(
    spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    const image = spec.image;
    const resources = RUNTIME_RESOURCE_TIERS[spec.resourceTier];

    const sandbox = await this.orchestrator.createSandbox({
      id: spec.runtimeId,
      name: spec.name,
      image,
      env: {
        AGENTPOD_HUB_URL: spec.hubUrl,
        // NOTE: enrollToken is injected here but never logged anywhere in
        // this module.  Do not add log statements that reference spec.enrollToken.
        AGENTPOD_ENROLL_TOKEN: spec.enrollToken,
      },
      volumes: [],
      ports: [],
      labels: {
        "agentpod.runtime.id": spec.runtimeId,
        "agentpod.managed": "true",
      },
      resources,
    });

    // Use runtimeId (= config.id) so that destroy/start/stop can pass it
    // directly to deleteSandbox/startSandbox/stopSandbox, which look up the
    // container by name "agentpod-<id>" or label agentpod.sandbox.id=<id>.
    // containerId is intentionally not used as the lifecycle key, but the
    // runtime the daemon reports for the container is worth carrying back:
    // it is the observed value, not the one we asked for.
    return { externalId: spec.runtimeId, runtime: sandbox.runtime };
  }

  /**
   * Permanently remove the container and its volumes.
   */
  async destroy(externalId: string): Promise<void> {
    await this.orchestrator.deleteSandbox(externalId, true);
  }

  /**
   * Start a previously stopped container.
   */
  async start(externalId: string): Promise<void> {
    await this.orchestrator.startSandbox(externalId);
  }

  /**
   * Stop a running container (without removing it).
   */
  async stop(externalId: string): Promise<void> {
    await this.orchestrator.stopSandbox(externalId);
  }
}
