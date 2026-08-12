/**
 * Fly Machines provisioner driver.
 *
 * One Fly APP PER RUNTIME, holding one volume and one machine:
 *
 *   - Its own `network`, so one runtime's machine cannot reach another's over
 *     6PN. A shared app would put every customer's station on one private
 *     network.
 *   - destroy() is then a single DELETE of the app, which takes the machine and
 *     the volume with it. A shared app would need three ordered deletes, each a
 *     new way to leak a volume that bills monthly.
 *
 * Creating an app requires an ORG-scoped token; Fly's app-scoped deploy tokens
 * can do everything else but not that. See docs/DEPLOYMENT.md.
 *
 * SECURITY: the enrolment token is sent in the machine's env and is never
 * logged by this module. Do not add log statements that reference
 * spec.enrollToken.
 */

import type {
  DriverManifest,
  ProvisionSpec,
  ResourceTier,
  RuntimeProvisioner,
  RuntimeState,
} from "./types";
import type { CredentialResolver } from "./credentials";
import { envCredentialResolver, requireCredentials } from "./credentials";
import type { FlyRequest, Pacer } from "./fly-api";
import { createFlyClient, FlyApiError } from "./fly-api";

// ─── Substrate constants ──────────────────────────────────────────────────────

/**
 * Where the volume is mounted inside the machine.
 *
 * The image's wrapper (fly/node-image/volume-workspace.sh) symlinks /workspace
 * here and points HOME here, because the rootfs is wiped on every stop→start
 * and /workspace is hardcoded in the fleet's OpenCode entrypoint.
 */
export const FLY_VOLUME_MOUNT = "/data";

/**
 * The volume's name. Fly requires lowercase alphanumerics and underscores — no
 * hyphens — so this cannot simply be the app name. It is a constant because
 * each runtime has an app to itself, so there is nothing to disambiguate.
 */
export const FLY_VOLUME_NAME = "agentpod_data";

/**
 * Shared-CPU sizings, mirroring the Docker driver's tiers (1g/2g/4g).
 *
 * Fly's constraint on shared CPUs: memory_mb must be a multiple of 256 and
 * between 256×cpus and 2048×cpus. Every row below is inside that.
 */
const FLY_TIERS: Record<
  ResourceTier,
  { cpu_kind: string; cpus: number; memory_mb: number }
> = {
  small: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
  medium: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
  large: { cpu_kind: "shared", cpus: 4, memory_mb: 4096 },
};

/** Seconds to give Fly's `wait?state=` endpoint before it answers 408. */
const WAIT_TIMEOUT_S = 60;

// ─── External id ──────────────────────────────────────────────────────────────

/**
 * The hub stores exactly one string per runtime, and every Fly route needs both
 * the app and the machine: /v1/apps/{app}/machines/{id}. So the handle is both.
 */
export function formatFlyExternalId(app: string, machineId: string): string {
  return `${app}/${machineId}`;
}

/**
 * Split a stored handle back into its two halves, or refuse.
 *
 * It refuses rather than returning a best effort because every caller
 * interpolates the result straight into a URL. A handle missing its app half
 * would build `/v1/apps//machines/x`, and one missing its machine half would
 * build `/v1/apps/x/machines/` — paths that address a DIFFERENT resource, or
 * none, and whose 404 would read as "the machine is already gone". On destroy
 * that is a silently leaked machine and volume, billing monthly.
 */
export function parseFlyExternalId(externalId: string): {
  app: string;
  machineId: string;
} {
  const slash = externalId.indexOf("/");
  if (slash <= 0 || slash === externalId.length - 1) {
    throw new Error(
      `fly: malformed external id "${externalId}" — expected "<app>/<machineId>"`
    );
  }
  return {
    app: externalId.slice(0, slash),
    machineId: externalId.slice(slash + 1),
  };
}

/**
 * Fly app names are DNS labels: lowercase alphanumerics and hyphens only. A
 * runtime id is `rt_<20 hex>`, whose underscore Fly rejects.
 */
export function flyAppNameFor(prefix: string, runtimeId: string): string {
  const slug = runtimeId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${slug}`;
}

/**
 * Fly's machine states, mapped to the three answers the hub understands.
 *
 * This mapping is load-bearing in a way most mappings are not: the hub writes
 * the runtime status `stopped` ONLY on what status() reports, and an operator
 * reads that word as "it has stopped costing me money". #260/#261 shipped on
 * 2026-08-13 because stopRuntime wrote `stopped` merely because the provisioner
 * call returned; a careless line here would reintroduce exactly that bug one
 * layer down, where the hub's evidence check cannot see it. So the line is drawn
 * on whether the machine is holding COMPUTE, not on whether the word sounds
 * final:
 *
 *   started, starting, replacing            → running
 *     All three have a guest allocated and billing. `starting` and `replacing`
 *     are transients, and transients toward *up* are safe to call running: the
 *     expensive mistake is only ever in the other direction.
 *
 *   stopped, suspended, destroyed           → stopped
 *     None of the three executes anything. `destroyed` is the same answer a 404
 *     gets below — a machine Fly no longer has cannot be running.
 *
 *     `suspended` is the one worth arguing about, because a suspended machine
 *     does still hold storage: Fly snapshots the guest's memory to disk. But
 *     storage cannot be the discriminator here, because a `stopped` Fly machine
 *     holds storage too — its rootfs, and in this driver's case the 3 GB volume
 *     that bills for as long as the app exists. `stopped` on this substrate has
 *     never meant "costing nothing"; destroy() is what means that. On the axis
 *     the hub is actually asking about, a suspended machine is down and is woken
 *     by the same POST .../start a stopped one is. Reporting it `running` would
 *     show the console a live station whose node-agent has been gone since the
 *     snapshot.
 *
 *   everything else                         → unknown
 *     `stopping`, `suspending`, `destroying`, `restarting`, `updating` are
 *     MID-FLIGHT. A stopping machine has not stopped, and claiming it has is
 *     precisely today's bug. `unknown` is the honest answer and the hub is built
 *     for it: sweepStalledRuntimeStops leaves the runtime `stopping` and asks
 *     again next tick, and only calls it an error after five minutes — it never
 *     asserts on an unanswered probe.
 *
 *     `created` means allocated but never run. This driver always starts what it
 *     creates, so seeing it means something happened that we did not do, which
 *     is exactly when a confident answer is worth least.
 *
 *     `failed`, `replaced` and `migrated` are terminal but their resource story
 *     is not settled: this driver sets restart.policy "always", and none of the
 *     2026-08-12 probes established what remains allocated in any of the three.
 *     An unmeasured guess about money is not an answer.
 *
 *     A state Fly adds next year lands here too, which is the safe place for it.
 */
export function flyStateToRuntimeState(state: unknown): RuntimeState {
  switch (state) {
    case "started":
    case "starting":
    case "replacing":
      return "running";
    case "stopped":
    case "suspended":
    case "destroyed":
      return "stopped";
    default:
      return "unknown";
  }
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export interface FlyMachinesOptions {
  /** Where FLY_API_TOKEN comes from. Injected in tests; env in production. */
  credentials?: CredentialResolver;
  orgSlug?: string;
  region?: string;
  appPrefix?: string;
  volumeSizeGb?: number;
  baseUrl?: string;
  /** Injectable fetch — used to inject a fake in unit tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Pass `noPacer` in tests; production gets the real 1/s bucket. */
  pacer?: Pacer;
}

export class FlyMachinesProvisioner implements RuntimeProvisioner {
  readonly provider = "fly" as const;

  readonly supportedTiers: ResourceTier[] = ["small", "medium", "large"];

  /**
   * MEASURED, not read. Every field below was established by probing a real Fly
   * account on 2026-08-12, in the style of the node-agent's CredentialPaths —
   * this repo has been bitten repeatedly by declarations written from
   * documentation, and the manifest is precisely the file where that costs a
   * user their workspace rather than costing us a redeploy.
   *
   * The probe, and what it saw:
   *
   *   - A `shared-cpu-1x` machine in `sin` with a 1 GB volume mounted at /data.
   *     Sentinel files written to BOTH `/` and the mount, then
   *     `POST .../machines/{id}/stop`, wait for `stopped`, `POST .../start`.
   *     After the restart: the sentinel on `/` was GONE; the sentinel on the
   *     mount was still there, byte-identical. The machine id was unchanged and
   *     the volume was still attached.
   *       → workspaceStorage: "volume", stopSemantics: "resumable".
   *     `persist_rootfs` was NOT used and must not be: Fly's own docs disclaim
   *     it for critical data, and the probe could not establish that it survives
   *     a full stop→start.
   *
   *   - The same machine, with NO `services` block, left idle for 25 minutes
   *     with only outbound traffic, sampled every 5 minutes: `started` at every
   *     sample. That is well past the 15 minutes at which Cloudflare's
   *     inbound-only idle timer tore down a live station on 2026-08-12. Fly's
   *     autostop is Fly-Proxy-driven and only reaches machines that publish
   *     inbound `services`.
   *       → idleBehaviour: "hub-driven". The driver must never define `services`.
   *
   *   - `config.image` is a required per-machine field of the create-machine
   *     body — the input Cloudflare has to refuse because wrangler bakes it at
   *     deploy time.
   *       → imageBinding: "per-instance".
   *
   *   - `config.guest` is per machine too, taking cpu_kind/cpus/memory_mb, so
   *     all three tiers map to real sizes rather than to one deployed constant.
   *     Shared-CPU memory_mb must be a multiple of 256 and within
   *     [256×cpus, 2048×cpus]; see FLY_TIERS, every row of which is inside that.
   *       → supportedTiers: all three.
   *
   *   - Nothing in the API or the account destroys a machine for age; the only
   *     reaper is autostop, ruled out above.
   *       → maxLifetimeMs: null.
   *
   *   - stop, start and status all exist as real routes
   *     (`POST .../stop`, `POST .../start`, `GET .../machines/{id}`) and the
   *     probe drove all three.
   *       → lifecycle: start, stop, status.
   *
   * One more measured fact that is not a manifest field but belongs with them:
   * region `bom` is refused on a non-paid plan ("legacy or non-paid plan") while
   * `sin` works, which is why `region` is configurable and why fly-api.ts
   * translates that refusal into a sentence naming FLY_REGION.
   */
  readonly manifest: DriverManifest = {
    provider: "fly",
    // The rootfs is wiped across stop/start; the mounted volume is not. The
    // workspace lives on the volume, and the image's wrapper is what puts it
    // there.
    workspaceStorage: "volume",
    // Machine id AND volume both survive a stop. This is a Docker-shaped
    // substrate in that one respect, and the only one.
    stopSemantics: "resumable",
    // Fly destroys nothing for age.
    maxLifetimeMs: null,
    // config.image is per machine — the input Cloudflare had to refuse.
    imageBinding: "per-instance",
    // config.guest is per machine too, so all three tiers map to real sizes.
    supportedTiers: ["small", "medium", "large"],
    // Fly's autostop is Fly-Proxy-driven and only touches machines with inbound
    // `services` configured. This driver defines none, so the trap that ruled
    // out Fly Sprites and bit Cloudflare cannot arise. The hub drives stop and
    // start itself, which it already does.
    idleBehaviour: "hub-driven",
    lifecycle: ["start", "stop", "status"],
  };

  private readonly request: FlyRequest;
  private readonly orgSlug: string;
  private readonly region: string;
  private readonly appPrefix: string;
  private readonly volumeSizeGb: number;

  constructor({
    credentials = envCredentialResolver(),
    orgSlug = process.env.FLY_ORG_SLUG || "personal",
    // Measured 2026-08-12: "bom" is refused on a non-paid plan, "sin" works.
    region = process.env.FLY_REGION || "sin",
    appPrefix = process.env.FLY_APP_PREFIX || "agentpod",
    volumeSizeGb = Number(process.env.FLY_VOLUME_SIZE_GB || 3),
    baseUrl,
    fetchImpl,
    pacer,
  }: FlyMachinesOptions = {}) {
    // The first real caller of credentials.ts. A missing key refuses to
    // construct, so a misconfigured deployment fails at boot with the variable
    // name in the message rather than on a user's first provision.
    const { FLY_API_TOKEN } = requireCredentials(
      "fly",
      ["FLY_API_TOKEN"],
      credentials
    );

    this.orgSlug = orgSlug;
    this.region = region;
    this.appPrefix = appPrefix;
    this.volumeSizeGb = volumeSizeGb;
    this.request = createFlyClient({
      token: FLY_API_TOKEN,
      baseUrl,
      fetchImpl,
      pacer,
    });
  }

  /**
   * Create a Fly app, a volume in it, and a machine mounting that volume.
   *
   * The order is not stylistic. A Fly volume is pinned to a physical host, so a
   * machine created before its volume can be placed on a different host and
   * fail to attach.
   */
  async provision(
    spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    const app = flyAppNameFor(this.appPrefix, spec.runtimeId);
    const guest = FLY_TIERS[spec.resourceTier];
    if (!guest) {
      throw new Error(
        `fly: cannot provision resource tier "${spec.resourceTier}"`
      );
    }

    await this.ensureApp(app);

    let machineId: string;
    try {
      const volumeId = await this.createVolume(app);
      machineId = await this.createMachine(app, volumeId, guest, spec);
    } catch (err) {
      // provision() is about to throw, so the hub will never learn this app's
      // name — nothing will ever come back to destroy it. An orphaned app with
      // a volume in it bills monthly for a runtime the console never showed.
      await this.deleteAppQuietly(app);
      throw err;
    }

    return {
      externalId: formatFlyExternalId(app, machineId),
      runtime: "fly-machine",
    };
  }

  /**
   * Create the app, tolerating one that is already there.
   *
   * A retried provision — or a destroy that failed after the app was made —
   * finds it existing. That is the state this method exists to produce, so it
   * is not an error.
   */
  private async ensureApp(app: string): Promise<void> {
    try {
      await this.request("POST", "/v1/apps", {
        app_name: app,
        org_slug: this.orgSlug,
        // Its own 6PN network. A shared network would put every customer's
        // station on one private network, reachable by internal DNS.
        network: app,
      });
    } catch (err) {
      if (
        err instanceof FlyApiError &&
        (err.status === 409 || /already\s+(exists|been taken)/i.test(err.message))
      ) {
        return;
      }
      throw err;
    }
  }

  private async createVolume(app: string): Promise<string> {
    const { body } = await this.request("POST", `/v1/apps/${app}/volumes`, {
      name: FLY_VOLUME_NAME,
      region: this.region,
      size_gb: this.volumeSizeGb,
    });
    const id = body.id;
    if (typeof id !== "string" || !id) {
      throw new Error(
        `fly: unexpected response from POST /v1/apps/${app}/volumes (no volume id)`
      );
    }
    return id;
  }

  private async createMachine(
    app: string,
    volumeId: string,
    guest: { cpu_kind: string; cpus: number; memory_mb: number },
    spec: ProvisionSpec
  ): Promise<string> {
    const { body } = await this.request("POST", `/v1/apps/${app}/machines`, {
      name: app,
      region: this.region,
      config: {
        // Honoured per machine — the input Cloudflare had to refuse.
        image: spec.image,
        guest,
        env: {
          AGENTPOD_HUB_URL: spec.hubUrl,
          // NOTE: never logged from this module. Do not add a log statement
          // that references spec.enrollToken.
          AGENTPOD_ENROLL_TOKEN: spec.enrollToken,
          // agentpod-node stores nodeId/nodeSecret under os.UserConfigDir(),
          // i.e. under HOME, and opencode keeps its session state under
          // $HOME/.local/share/opencode. On the rootfs both are wiped by every
          // stop→start; on the volume neither is.
          HOME: `${FLY_VOLUME_MOUNT}/home`,
        },
        mounts: [{ volume: volumeId, path: FLY_VOLUME_MOUNT }],
        // The default, on-failure, leaves a machine `stopped` after a clean
        // exit — a station that quietly never comes back.
        restart: { policy: "always" },
        metadata: {
          agentpod_runtime_id: spec.runtimeId,
          agentpod_managed: "true",
        },
        // DELIBERATELY NO `services`. Fly's autostop is Fly-Proxy-driven and
        // only touches machines with inbound services configured. Measured
        // 2026-08-12: 25 minutes idle with only outbound traffic, `started`
        // throughout. Adding a services block here would recreate Cloudflare's
        // failure exactly — a node-agent dials out and receives nothing, so a
        // busy station reads as idle and gets reaped mid-session.
        //
        // And deliberately no `persist_rootfs`: Fly's own docs disclaim it for
        // critical data. The volume above is the answer.
      },
    });

    const id = body.id;
    if (typeof id !== "string" || !id) {
      throw new Error(
        `fly: unexpected response from POST /v1/apps/${app}/machines (no machine id)`
      );
    }
    return id;
  }

  /**
   * Best effort cleanup of a half-built runtime. Never throws: the caller is
   * already throwing the real failure, and replacing it with a cleanup error
   * would hide why provisioning failed.
   */
  private async deleteAppQuietly(app: string): Promise<void> {
    try {
      await this.request("DELETE", `/v1/apps/${app}`);
    } catch {
      // Swallowed on purpose — see above.
    }
  }

  async destroy(_externalId: string): Promise<void> {
    throw new Error("fly: destroy() is not implemented yet");
  }

  /**
   * Start a stopped machine and give Fly a chance to confirm it.
   *
   * It waits rather than trusting the POST: `POST .../start` returns as soon as
   * Fly has accepted the request, which is not the same as a machine being up —
   * the same gap that produced #261, where a `stopped` was written because a
   * call returned rather than because anything had confirmed it. Measured
   * 2026-08-12: a start keeps the machine id and re-attaches the volume, but the
   * ROOTFS IS WIPED, so nothing about the previous run's filesystem carries over
   * and there is nothing to reuse here — the machine is coming up cold, which is
   * exactly why it is worth waiting for.
   *
   * The wait is still not the hub's source of truth: startRuntime writes
   * `starting`, never `online`, and only an enrolment writes `online`. It means
   * an ordinary start has usually already happened by the time the API call
   * returns, instead of leaving the console spinning for a sweeper tick.
   */
  async start(externalId: string): Promise<void> {
    const { app, machineId } = parseFlyExternalId(externalId);
    await this.request("POST", `/v1/apps/${app}/machines/${machineId}/start`);
    await this.waitFor(app, machineId, "started");
  }

  /**
   * Block on Fly's `wait?state=` until the machine reaches a state, or until
   * Fly gives up.
   *
   * A 408 is swallowed on purpose: it is Fly saying "not yet", not "it failed".
   * The hub already has the machinery for a machine that is slow or never
   * arrives — `starting`/`stopping` plus sweepStalledRuntimeStarts and
   * sweepStalledRuntimeStops — and a driver that threw here would turn a slow
   * image pull into an error in the operator's face for a machine that was
   * coming up fine.
   *
   * The exemption is exactly one status wide, and that narrowness is the whole
   * point. EVERY other status still throws: a 404 or a 422 is a refusal and a
   * 500 is a fault, and a helper that shrugged at all of them would report a
   * confident outcome on no evidence — the failure mode of #261, pointed the
   * other way. Telling the two apart is only possible because FlyApiError
   * carries `status`.
   */
  private async waitFor(
    app: string,
    machineId: string,
    state: "started" | "stopped",
    instanceId?: string
  ): Promise<void> {
    const query = new URLSearchParams({ state, timeout: String(WAIT_TIMEOUT_S) });
    // Fly REQUIRES instance_id when waiting for `stopped` — a start assigns a
    // new one (measured 2026-08-12), so "which run of this machine" is a real
    // question and the stop wait refuses to guess. Started-waits ignore it, so
    // the parameter is carried here rather than duplicated in the caller.
    if (instanceId) query.set("instance_id", instanceId);

    try {
      await this.request(
        "GET",
        `/v1/apps/${app}/machines/${machineId}/wait?${query.toString()}`
      );
    } catch (err) {
      if (err instanceof FlyApiError && err.status === 408) return;
      throw err;
    }
  }

  /**
   * Stop a running machine, and wait for Fly to confirm it went down.
   *
   * `POST .../stop` is ASYNCHRONOUS: it answers `{"ok": true}` immediately and
   * says nothing about state. Returning on that alone is exactly the shape of
   * #260/#261 — a `stopped` written because a call returned, which an operator
   * reads as "this has stopped costing me money". So the driver waits, and the
   * hub still asks status() afterwards: stopRuntime writes `stopping` and only
   * ever writes `stopped` on the evidence status() returns. This wait just means
   * the ordinary case resolves before the operator can look away.
   *
   * The instance id is read FIRST because Fly requires it when waiting for
   * `stopped` — a start assigns a new one (measured 2026-08-12), so "which run
   * of this machine" is a real question the wait refuses to guess. Read after
   * the stop it would be racing the very transition being waited on.
   */
  async stop(externalId: string): Promise<void> {
    const { app, machineId } = parseFlyExternalId(externalId);
    const instanceId = await this.instanceIdOf(app, machineId);
    // No body: the defaults are SIGINT and Fly's own kill timeout, which is what
    // a station's node-agent should be given a chance to shut down on.
    await this.request("POST", `/v1/apps/${app}/machines/${machineId}/stop`);
    await this.waitFor(app, machineId, "stopped", instanceId);
  }

  /**
   * The current instance id, or undefined if Fly did not report one.
   *
   * Undefined rather than a throw: a wait without instance_id is a worse outcome
   * than a stop that cannot be waited on, and a runtime that cannot be stopped
   * is a runtime that keeps billing. The stop still goes out either way; only
   * the confirmation is given up, and the sweeper's status() probe is what
   * settles it in that case.
   */
  private async instanceIdOf(
    app: string,
    machineId: string
  ): Promise<string | undefined> {
    const { body } = await this.request(
      "GET",
      `/v1/apps/${app}/machines/${machineId}`
    );
    return typeof body.instance_id === "string" && body.instance_id
      ? body.instance_id
      : undefined;
  }

  /**
   * Ask Fly whether this machine is actually running.
   *
   * This is the ONLY evidence behind a `stopped` runtime on this substrate:
   * stopRuntime writes `stopping` and confirms `stopped` on nothing but what
   * this returns. The mapping from Fly's word to that answer is deliberate and
   * documented on flyStateToRuntimeState — read it before changing a case.
   *
   * A 404 is reported `stopped`, and that is a real answer rather than a shrug:
   * a machine Fly has no record of is not running and cannot be billing, the
   * same answer the Docker driver gives for a container the daemon forgot.
   * Telling it apart from a transport failure is only possible because
   * FlyApiError carries `status`.
   *
   * EVERYTHING ELSE THROWS, and the narrowness is the point. An expired
   * FLY_API_TOKEN 401s on every machine at once; a rate limit answers 429; Fly
   * having a bad day answers 500; the network answers with no status at all.
   * None of those is evidence that anything stopped, and a driver that folded
   * them into `stopped` would report the whole fleet as having stopped costing
   * money at the moment it lost the ability to look. The service layer catches
   * the throw and degrades it to `unknown` itself (probeState in
   * ../runtimes.ts, which logs the failure), so a probe that could not be
   * answered stays visible instead of being laundered into an answer here.
   */
  async status(externalId: string): Promise<RuntimeState> {
    const { app, machineId } = parseFlyExternalId(externalId);
    try {
      const { body } = await this.request(
        "GET",
        `/v1/apps/${app}/machines/${machineId}`
      );
      return flyStateToRuntimeState(body.state);
    } catch (err) {
      if (err instanceof FlyApiError && err.status === 404) return "stopped";
      throw err;
    }
  }
}
