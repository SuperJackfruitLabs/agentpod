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

import type {
  RuntimeProvisioner,
  ProvisionSpec,
  RuntimeState,
  DriverManifest,
  LifecycleResult,
} from "./types";
import { DockerOrchestrator } from "./docker-orchestrator";
import type { ResourceLimits, Sandbox } from "./docker-orchestrator";
import { dockerDaemonSettingsFromEnv, resolveDockerDaemon } from "./docker-daemon";

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

/**
 * "1g" → 1024. Only the two suffixes the table above uses; anything else — a
 * typo, or no limit at all — is worth refusing at import rather than silently
 * sizing a container wrong, or declaring a tier whose size is a guess.
 */
function limitToMb(limit: string | undefined): number {
  const parsed = limit ? /^(\d+)(g|m)$/.exec(limit) : null;
  if (!parsed) throw new Error(`docker: unparseable memory limit "${limit}"`);
  const value = Number(parsed[1]);
  return parsed[2] === "g" ? value * 1024 : value;
}

/**
 * What each tier gives, in MB, read off the limits actually sent to the daemon.
 *
 * Derived rather than restated: the hub compares this against a harness's
 * measured requirement (issue #279), and a second hand-maintained copy of these
 * numbers is precisely the drift that let a harness be offered a tier it cannot
 * live in. Docker learned the same lesson from the other end on 2026-08-09 — an
 * opencode ACP session OOM-killed at 513 MB inside a 512m cgroup.
 */
const DOCKER_TIER_MEMORY_MB = Object.fromEntries(
  Object.entries(RUNTIME_RESOURCE_TIERS).map(([tier, limits]) => [
    tier,
    limitToMb(limits.memory),
  ])
) as Record<"small" | "medium" | "large", number>;

// ─── "The daemon says there is no such container" ─────────────────────────────

/**
 * True only for DockerOrchestrator's own "nothing matched" signal.
 *
 * That message is thrown by `getContainer` **after** two successful
 * `listContainers` calls — one by name, one by label — so it is an answer from
 * a reachable daemon, not a failure to ask. Every way of not reaching the
 * daemon (`connect ENOENT /var/run/docker.sock`, ECONNREFUSED, a TLS or
 * timeout error from dockerode) surfaces as a different error out of
 * `listContainers` and is deliberately NOT matched here: an unreachable daemon
 * must never read as "already gone", because the container may well still be
 * running and billing.
 */
function isAlreadyGone(err: unknown): boolean {
  return (err as Error)?.message?.startsWith("Sandbox not found") === true;
}

// ─── "The container is already like that" ─────────────────────────────────────

/**
 * True only for Docker's 304 on start/stop, which means the requested end state
 * ALREADY HOLDS.
 *
 * The daemon answers `304 Not Modified` to `POST /containers/{id}/start` for a
 * running container and to `POST /containers/{id}/stop` for one that is already
 * down; dockerode names those two statuses "container already started" and
 * "container already stopped" (dockerode/lib/container.js), and docker-modem
 * raises them as an Error carrying `statusCode` and `reason`. Before this
 * existed the exception travelled up untouched and `POST /api/runtimes/:id/start`
 * answered `500 An unexpected error occurred` for a double-click, filling the
 * error log with `Unhandled error` for a benign condition — the same noise that
 * made a real driver failure indistinguishable from a redundant click (#284).
 *
 * MATCHED ON THE STATUS, not on the words. The message is English prose from a
 * daemon we do not version-pin and would drag every other 304-shaped sentence in
 * with it; `statusCode` is the structured field docker-modem sets from the HTTP
 * response. The message is only a fallback for a transport that lost the field,
 * and it is anchored to the exact `(HTTP code 304)` prefix modem builds —
 * verbatim what the live hub logged on 2026-08-13.
 *
 * Scoped to start/stop and used nowhere else. 304 is not a general "fine" from
 * Docker: it is only meaningful on the two verbs whose whole purpose is to reach
 * a state. Every other refusal — 404 no such container, 409, 500, or a socket
 * that will not connect — still throws, because none of them is evidence that
 * the container is in the state anyone asked for.
 */
function isAlreadyInTargetState(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string } | null;
  if (e?.statusCode === 304) return true;
  return e?.message?.includes("(HTTP code 304)") === true;
}

// ─── "That image is not on this daemon" ───────────────────────────────────────

/**
 * Docker's 404 at create, rewritten to name the machine that lacks the image.
 *
 * THE HUB NEVER PULLS. `createContainer` runs whatever the daemon already has
 * and 404s otherwise, which on the local daemon is nearly invisible — the image
 * is there because someone ran `docker build` on that box, per
 * docs/DEPLOYMENT.md step 3. Point DOCKER_HOST at another machine and the same
 * build has to have happened THERE; `agentpod-node:local` is a tag in one
 * daemon's store and means nothing in another's. That is the same trap as
 * issue #283 on Modal, one substrate over, and the raw daemon error names
 * neither the daemon nor the fix.
 */
function describeMissingImage(
  err: unknown,
  image: string,
  daemon: string
): Error | null {
  const message = (err as Error)?.message ?? "";
  if (!/no such image/i.test(message)) return null;
  return new Error(
    `docker: image "${image}" is not present on the daemon at ${daemon}. The hub never ` +
      `pulls — it creates containers from images the daemon already holds — so build or ` +
      `\`docker pull\` this image ON THAT HOST, or point NODE_AGENT_*_IMAGE at a ` +
      `reference that is present there. Original error: ${message}`
  );
}

// ─── Where the daemon is ──────────────────────────────────────────────────────

/**
 * The orchestrator this driver uses when nobody injects one, built from the
 * hub's environment.
 *
 * Throws rather than degrading. It is the backstop behind validate-config's
 * boot refusal, in the shape FlyMachinesProvisioner already uses: an operator
 * who asked for a remote daemon and mis-set it must not get a hub that quietly
 * provisions onto the control-plane box instead — that failure is invisible
 * precisely because everything works.
 */
function orchestratorFromEnv(
  env: Partial<Record<string, string>> = process.env
): DockerOrchestrator {
  const { connection, problems, warnings } = resolveDockerDaemon(
    dockerDaemonSettingsFromEnv(env)
  );
  if (!connection) {
    throw new Error(
      "docker: refusing to start with this daemon configuration — " +
        problems.map((p) => `${p.field}: ${p.message}`).join(" ")
    );
  }
  for (const warning of warnings) console.warn(`⚠️  ${warning}`);
  if (connection.remote) {
    // Worth a line in the log on every boot: which machine the fleet's
    // containers are actually on is not otherwise visible from the hub.
    console.log(`Docker provisioner → remote daemon ${connection.describe}`);
  }
  return new DockerOrchestrator({
    daemon: connection,
    // Set by the operator to harden the host, e.g. DOCKER_RUNTIME=runsc for
    // gVisor. Unset keeps Docker's default and today's exact behaviour.
    // NOTE: this names a runtime installed on THE DAEMON'S host, which with a
    // remote daemon is not this machine — `runsc` being present here says
    // nothing about there.
    runtime: env.DOCKER_RUNTIME || "",
    // config.ts has exposed DOCKER_NETWORK for a long time but nothing ever
    // passed it here, so the orchestrator always used its own default. That
    // matters now: a sandboxed runtime REQUIRES a built-in network, because
    // Docker's embedded resolver is unreachable from one (#243). The network
    // likewise lives on the daemon's host; the orchestrator creates it there.
    defaultNetwork: env.DOCKER_NETWORK || "agentpod-net",
  });
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export class DockerRuntimeProvisioner implements RuntimeProvisioner {
  readonly provider = "docker" as const;

  /**
   * What this driver already does — not what it might grow into.
   *
   * Docker is the outlier the rest of the interface was accidentally designed
   * around: it is the only surveyed substrate whose workspace survives a
   * stop→start on the container filesystem, which is exactly why every other
   * driver's differences went unnoticed until production.
   */
  readonly manifest: DriverManifest = {
    provider: "docker",
    // The container filesystem itself. No archive, no volume — the rootfs is
    // still there after stopSandbox, which is the assumption the interface
    // silently inherited and Cloudflare then violated.
    workspaceStorage: "rootfs",
    // stopSandbox pauses the container; startSandbox brings the same container
    // back with the same id and the same disk.
    stopSemantics: "resumable",
    // The daemon reaps nothing on a clock. A container runs until told not to.
    maxLifetimeMs: null,
    // spec.image goes straight into createSandbox — the driver is deliberately
    // image-agnostic and never reads NODE_AGENT_IMAGE itself.
    imageBinding: "per-instance",
    // All three map to real cpu/memory/pids limits in RUNTIME_RESOURCE_TIERS
    // above; none is refused.
    supportedTiers: ["small", "medium", "large"],
    // And how big each one is, so "can this harness live here?" is answerable
    // before a container exists rather than after an OOM kill.
    tierMemoryMb: DOCKER_TIER_MEMORY_MB,
    // Nothing sleeps an idle container. Docker has no notion of inbound
    // activity to key idleness on, so the trap that ruled out Fly Sprites and
    // bit Cloudflare cannot arise here.
    idleBehaviour: "never",
    // All three are implemented below, status included — which is why a Docker
    // runtime can be written `stopped` on evidence rather than assumption.
    lifecycle: ["start", "stop", "status"],
  };

  /**
   * @param orchestrator Injected for testing; defaults to one built from the
   *   hub's environment by `orchestratorFromEnv` — the local socket unless
   *   DOCKER_HOST says otherwise.
   */
  constructor(
    private readonly orchestrator: DockerOrchestrator = orchestratorFromEnv()
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

    const sandbox = await this.createSandbox(spec, image, resources);

    // Use runtimeId (= config.id) so that destroy/start/stop can pass it
    // directly to deleteSandbox/startSandbox/stopSandbox, which look up the
    // container by name "agentpod-<id>" or label agentpod.sandbox.id=<id>.
    // containerId is intentionally not used as the lifecycle key, but the
    // runtime the daemon reports for the container is worth carrying back:
    // it is the observed value, not the one we asked for.
    return { externalId: spec.runtimeId, runtime: sandbox.runtime };
  }

  /** createSandbox, with Docker's "no such image" 404 made actionable. */
  private async createSandbox(
    spec: ProvisionSpec,
    image: string,
    resources: ResourceLimits
  ): Promise<Sandbox> {
    try {
      return await this.orchestrator.createSandbox({
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
    } catch (err) {
      throw (
        describeMissingImage(err, image, this.orchestrator.describeDaemon?.() ?? "the daemon") ??
        err
      );
    }
  }

  /**
   * Permanently remove the container and its volumes.
   *
   * Idempotent (conformance rule 6): a container the daemon has no record of is
   * already in the state destroy is asked to produce, so this returns rather
   * than throwing. It has to. `destroyRuntime` turns a driver throw into a 502
   * and leaves the row un-destroyed, so before this tolerance existed a destroy
   * that half-succeeded — container removed, a later step failed — could never
   * be retried to completion and wedged the runtime permanently.
   *
   * Only that one condition is forgiven (see isAlreadyGone). A daemon that
   * cannot be reached still throws: reporting a successful destroy for a
   * container nobody could look at would be the worse bug.
   */
  async destroy(externalId: string): Promise<void> {
    try {
      await this.orchestrator.deleteSandbox(externalId, true);
    } catch (err) {
      if (isAlreadyGone(err)) return;
      throw err;
    }
  }

  /**
   * Start a previously stopped container.
   *
   * A container that is already running is the state this method is asked to
   * produce, so it reports a no-op rather than throwing — see
   * isAlreadyInTargetState for why that is exactly one status wide.
   */
  async start(externalId: string): Promise<LifecycleResult> {
    try {
      await this.orchestrator.startSandbox(externalId);
    } catch (err) {
      if (!isAlreadyInTargetState(err)) throw err;
      return {
        alreadyInTargetState: true,
        detail: "the daemon reports this container is already running",
      };
    }
  }

  /**
   * Stop a running container (without removing it).
   *
   * Symmetrical with start(): a container that is already down is the state this
   * asks for. The hub still confirms it with status() before writing `stopped`
   * — a driver saying "it was already stopped" is not the evidence that word
   * needs, and stopRuntime() is deliberately built to go and look.
   */
  async stop(externalId: string): Promise<LifecycleResult> {
    try {
      await this.orchestrator.stopSandbox(externalId);
    } catch (err) {
      if (!isAlreadyInTargetState(err)) throw err;
      return {
        alreadyInTargetState: true,
        detail: "the daemon reports this container is already stopped",
      };
    }
  }

  /**
   * Ask the daemon whether this container is actually running.
   *
   * The evidence behind a `stopped` runtime. Docker's stop is synchronous, so
   * in practice this confirms immediately — but it confirms, rather than
   * assuming, and that difference is the whole point (see stopRuntime).
   *
   * A container the daemon has no record of is reported `stopped`: that is a
   * real answer — it is not running and cannot be billing. A daemon that cannot
   * be reached at all throws, and the service layer degrades that to `unknown`
   * rather than letting silence read as confirmation.
   */
  async status(externalId: string): Promise<RuntimeState> {
    let sandbox: Sandbox;
    try {
      sandbox = await this.orchestrator.inspectSandbox(externalId);
    } catch (err) {
      if (isAlreadyGone(err)) return "stopped";
      throw err;
    }

    switch (sandbox.status) {
      // Still holding its resources, whatever it is doing with them. A paused
      // container is charged for exactly like a running one.
      case "running":
      case "paused":
      case "restarting":
        return "running";
      case "exited":
      case "dead":
      case "stopped":
      // "created" — never started, so never running.
      case "creating":
        return "stopped";
      // "removing" / "error" / "unknown": mid-flight or unreadable. Not an
      // answer, and must not be rounded to one.
      default:
        return "unknown";
    }
  }
}
