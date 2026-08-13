/**
 * Fleet-era RuntimeProvisioner interface + supporting types (P4 Task 4).
 *
 * A RuntimeProvisioner creates and manages node-agent containers/sandboxes
 * that auto-enroll into the fleet via one-time enrollment tokens.
 */

import type { TierMemoryMb } from "@agentpod/contract";

export type { TierMemoryMb };

/**
 * A provider name. Deliberately not a union.
 *
 * The union it replaces (`"docker" | "cloudflare"`) meant a new driver could
 * not be *named* without editing the contract, this file and the console — and
 * the compiler could not tell you which of the two names in the literal set was
 * actually usable, because that depends on what is registered and enabled at
 * runtime, not on what someone typed here. Validity is now answered by the
 * registry: `getProvisioner` refuses a name no driver registered, and
 * `isProviderEnabled` refuses one this deployment has not turned on.
 */
export type RuntimeProviderName = string;

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
 * What a lifecycle verb has to say about itself when it did nothing.
 *
 * `start` and `stop` are requests for an END STATE, not for work, so "it was
 * already like that" is a successful outcome and not a failure. Before this
 * existed there was no way for a driver to say it, and the only channel left was
 * an exception: Docker answers a redundant start or stop with HTTP 304, the
 * driver forwarded it, and the route turned it into
 * `500 {"error":"Internal Server Error"}` for two clicks on Start (issue #284).
 *
 * A RETURN VALUE rather than a typed error, deliberately. The bug was precisely
 * that a non-failure travelled on the failure channel; putting it back there in
 * a nicer costume keeps every caller one forgotten `instanceof` away from the
 * same 500, and would make `catch` the place where success is decided. Widening
 * the return type costs nothing at the call sites that ignore it — `void` is
 * assignable to this union, so every existing driver and test fake still
 * satisfies the interface unchanged.
 */
export interface LifecycleOutcome {
  /**
   * The substrate reported the instance was ALREADY in the state this verb asks
   * for. Set it ONLY on that answer — never on a failure whose meaning is
   * unclear, and never on a substrate that could not be reached at all, because
   * an unreachable substrate is silence and silence is not evidence.
   */
  alreadyInTargetState?: boolean;
  /** The substrate's own words, for the log. Never a promise about state. */
  detail?: string;
}

/** What `start()`/`stop()` resolve to. `void` for a driver with nothing to add. */
export type LifecycleResult = void | LifecycleOutcome;

/**
 * True only when a driver said, in so many words, that its instance was already
 * in the target state.
 *
 * Takes `unknown` so a caller can hand it anything a driver resolved with —
 * including the `undefined` every driver that says nothing returns — without a
 * cast at every call site.
 */
export function wasAlreadyInTargetState(result: unknown): boolean {
  return (
    (result as LifecycleOutcome | null)?.alreadyInTargetState === true
  );
}

/**
 * What a driver declares about its substrate, before anyone runs it.
 *
 * Every field here exists because its absence already cost something. The
 * interface this replaces was designed around Docker — the one substrate whose
 * disk survives a stop, whose image is chosen per container, and which never
 * reaps anything for being idle. Each of those Docker-shaped assumptions was
 * discovered to be wrong only in production, on a substrate that did not share
 * it. Declaring them makes the next substrate's differences a compile-time
 * question instead of an incident.
 *
 * The manifest is REQUIRED on every driver, so omitting one does not compile.
 */
export interface DriverManifest {
  /**
   * Stable provider name.
   *
   * Replaces the hardcoded RuntimeProviderName union: a fifth driver should not
   * require an edit in the contract, the hub and the console just to be named.
   */
  readonly provider: string;

  /**
   * Where a station's workspace actually survives, if anywhere.
   *
   * Deliberately not a boolean. "Is the disk persistent?" is a question that
   * flatters Docker and hides the interesting part; three of the four surveyed
   * substrates destroy the workspace on the rootfs, and each answers with a
   * different mechanism — a volume, an external archive (our R2 snapshots), or
   * nothing at all. The R2 machinery built for Cloudflare is the general case,
   * not the exception.
   */
  readonly workspaceStorage: "rootfs" | "volume" | "external-archive";

  /**
   * Does stop→start preserve the instance, or is stop the end of it?
   *
   * THE field. Had it been required, the Cloudflare workspace loss would have
   * been a compile-time question rather than a production discovery: a
   * container whose disk is wiped on sleep, found out when a user's file
   * vanished. The interface had no way to say "my disk does not survive", so
   * nobody was ever made to think about it. An author forced to type
   * "terminal" here has to answer, at that moment, what happens to the files.
   */
  readonly stopSemantics: "resumable" | "terminal";

  /**
   * Platform-imposed ceiling after which the substrate destroys a healthy
   * runtime, regardless of what it is doing. `null` means no such ceiling.
   *
   * Modal's hard 24-hour sandbox lifetime is the case in point: a limit that is
   * invisible in every test short enough to run in CI, and fatal to a long-lived
   * station.
   */
  readonly maxLifetimeMs: number | null;

  /**
   * Can ProvisionSpec.image be honoured per instance, or is it fixed at deploy
   * time?
   *
   * Cloudflare's image is baked into the worker at deploy, and the driver
   * silently ignored spec.image until someone noticed the wrong harness had
   * booted. Declaring it turns a hand-written refusal into an enforced one.
   */
  readonly imageBinding: "per-instance" | "fixed";

  /**
   * Tiers this driver can actually satisfy.
   *
   * resourceTier used to be dropped on the floor by drivers that could not vary
   * sizing — Cloudflare fixes instance_type per class at worker deploy time.
   * The console builds its tier list from this rather than a hardcoded map that
   * rots the moment a worker is redeployed at a different instance type.
   */
  readonly supportedTiers: readonly ResourceTier[];

  /**
   * How much memory each supported tier actually gives, in MB.
   *
   * `supportedTiers` on its own says a size can be CREATED; it says nothing
   * about what fits inside it. That is the gap issue #279 fell through: Fly's
   * `small` is 1 GB, the console offered it for the `opencode` harness, and one
   * chat turn peaked at 855 MB of harness on top of ~157 MB of OS and
   * node-agent — the whole machine. Provisioning, volume mount, enrolment and
   * the first response all looked healthy; the user met the defect as an
   * apparent hub outage.
   *
   * With a number here the hub can compare a tier against
   * HARNESS_MIN_MEMORY_MB and refuse the pair before anything is created, and
   * the console can decline to offer it — see harnessTiersFor() in the
   * contract. Partial on purpose: a driver declares the tiers it supports and
   * invents nothing for the ones it does not (Cloudflare fixes instance_type at
   * worker deploy time and has exactly one). Conformance rule 2 requires an
   * entry for every tier in `supportedTiers`, so the omission cannot be a
   * quiet exemption from the check.
   */
  readonly tierMemoryMb: TierMemoryMb;

  /**
   * Who sleeps an idle runtime, and on what signal.
   *
   * "platform-inbound" is the trap: platforms that key idleness on INBOUND
   * activity read our fleet as idle while it is busy, because the node-agent
   * dials out and receives nothing. That is what tore down Cloudflare sandboxes
   * mid-work, and it is why Fly Sprites were ruled out. "hub-driven" means the
   * hub decides; "never" means the substrate reaps nothing on its own.
   */
  readonly idleBehaviour: "never" | "platform-inbound" | "hub-driven";

  /**
   * Lifecycle verbs beyond provision/destroy that this driver implements.
   *
   * These are optional methods on RuntimeProvisioner, which until now were
   * discovered by reading other drivers. `status` in particular is the ONLY
   * evidence the hub has for writing `stopped` — a substrate that cannot answer
   * must say so here rather than have its silence read as confirmation.
   */
  readonly lifecycle: readonly ("start" | "stop" | "status")[];
}

/**
 * Implemented by each driver (docker, cloudflare) to create/manage runtimes.
 */
export interface RuntimeProvisioner {
  /** What this driver declares about its substrate. Required: see DriverManifest. */
  readonly manifest: DriverManifest;

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
   *
   * Resolving means the substrate accepted the request — NOT that a node exists;
   * see startRuntime() in ../runtimes.ts, which writes `starting`, never
   * `online`. A driver whose substrate answers "it is already running" must
   * resolve with `{ alreadyInTargetState: true }` rather than throw: that is the
   * state the caller asked for, and a throw becomes a 500 for a redundant click
   * (#284). Every OTHER failure must still throw — the point is to name the
   * benign case exactly, not to swallow a class of errors.
   */
  start?(externalId: string): Promise<LifecycleResult>;

  /**
   * Stop a running runtime without destroying it (optional — Docker only).
   *
   * Same contract as start(), pointed the other way: "it is already stopped" is
   * `{ alreadyInTargetState: true }`, and nothing else is.
   */
  stop?(externalId: string): Promise<LifecycleResult>;

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
