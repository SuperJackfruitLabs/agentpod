/**
 * Fleet-era RuntimeProvisioner interface + supporting types (P4 Task 4).
 *
 * A RuntimeProvisioner creates and manages node-agent containers/sandboxes
 * that auto-enroll into the fleet via one-time enrollment tokens.
 */

export type RuntimeProviderName = "docker" | "cloudflare";

/** Resource tier controlling CPU/memory allocation. */
export type ResourceTier = "small" | "medium" | "large";

/**
 * The spec passed to a provisioner when creating a new runtime.
 * Contains everything the container/sandbox needs to boot and self-enroll.
 */
export interface ProvisionSpec {
  /** Stable DB id of the provisioned_runtimes row (used as a label/tag). */
  runtimeId: string;
  /** Human-readable name for the runtime. */
  name: string;
  /** Resource tier controlling CPU/memory allocation. */
  resourceTier: "small" | "medium" | "large";
  /** Hub URL injected as AGENTPOD_HUB_URL into the container env. */
  hubUrl: string;
  /** One-time enrollment token injected as AGENTPOD_ENROLL_TOKEN. Never log. */
  enrollToken: string;
  /**
   * Container image to run. Resolved by the service layer via imageForHarness()
   * so drivers are image-agnostic — they always use this value, never read
   * NODE_AGENT_IMAGE themselves.
   */
  image: string;
}

/**
 * What a substrate says about a runtime's container, right now.
 *
 * `unknown` is a first-class answer, not a failure: a driver that cannot see
 * the container (an old worker deployment, a transport error, a container the
 * substrate has forgotten) must be able to say so. The one thing no driver may
 * ever do is guess `stopped`, because the hub turns that into a claim an
 * operator reads as "this has stopped costing me money".
 */
export type RuntimeState = "running" | "stopped" | "unknown";

/**
 * Implemented by each driver (docker, cloudflare) to create/manage runtimes.
 */
export interface RuntimeProvisioner {
  readonly provider: RuntimeProviderName;

  /**
   * Tiers this driver can actually satisfy. Omit when the driver supports all
   * of them (Docker maps each to real cpu/memory limits).
   *
   * Cloudflare fixes instance_type at worker deploy time, so it supports
   * exactly one — and the console reads this rather than hardcoding a map that
   * would rot the moment a worker is redeployed at a different instance type.
   */
  readonly supportedTiers?: ResourceTier[];

  /**
   * Create and start a new runtime for the given spec.
   *
   * Returns the provider-specific external identifier (container id, sandbox
   * id, …), and — where the provider can report it — the container runtime
   * actually used. `runtime` is optional so providers with no such concept
   * (Cloudflare) are unaffected.
   */
  provision(spec: ProvisionSpec): Promise<{ externalId: string; runtime?: string }>;

  /**
   * Permanently destroy the runtime identified by externalId.
   */
  destroy(externalId: string): Promise<void>;

  /**
   * Start a stopped runtime (optional — not supported by ephemeral providers).
   */
  start?(externalId: string): Promise<void>;

  /**
   * Stop a running runtime without destroying it (optional — Docker only).
   */
  stop?(externalId: string): Promise<void>;

  /**
   * Ask the substrate whether this runtime's container is actually running.
   *
   * Optional on purpose: a driver with no way to answer must not be forced to
   * lie. The service layer treats its absence as "unverifiable" and says so in
   * the runtime's statusReason rather than pretending it confirmed anything —
   * see stopRuntime() in ../runtimes.ts.
   *
   * This is the ONLY evidence the hub has for writing `stopped`. The absence of
   * a node is not evidence: nodes go offline for network reasons while their
   * container runs, and bills, perfectly happily.
   */
  status?(externalId: string): Promise<RuntimeState>;
}
