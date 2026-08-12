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

  async provision(
    _spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    throw new Error("fly: provision() is not implemented yet");
  }

  async destroy(_externalId: string): Promise<void> {
    throw new Error("fly: destroy() is not implemented yet");
  }

  async start(_externalId: string): Promise<void> {
    throw new Error("fly: start() is not implemented yet");
  }

  async stop(_externalId: string): Promise<void> {
    throw new Error("fly: stop() is not implemented yet");
  }

  async status(_externalId: string): Promise<RuntimeState> {
    throw new Error("fly: status() is not implemented yet");
  }
}
