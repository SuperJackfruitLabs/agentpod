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
import { ModalNotFoundError } from "./modal-api";

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

/**
 * The sandbox's main process.
 *
 * Passed as a COMMAND, not baked as an ENTRYPOINT: Modal requires any image
 * ENTRYPOINT to `exec "$@"`, and our node-agent entrypoint does not — it enrols
 * and then execs its own run loop. Dockerfile.modal clears ENTRYPOINT and this
 * supplies the command instead. See Task 13.
 */
export const MODAL_ENTRYPOINT = ["/modal-entrypoint.sh"];

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
      // Straight off MODAL_RESOURCE_TIERS, the same table provision() sizes the
      // sandbox from, so the hub's "does this harness fit?" (issue #279) is
      // asked of the sandbox that will actually be created. MiB is treated as
      // MB throughout: the 5% difference is far inside the headroom the
      // requirement carries, and Modal's own field is memoryMiB.
      tierMemoryMb: Object.fromEntries(
        Object.entries(MODAL_RESOURCE_TIERS).map(([tier, res]) => [tier, res.memoryMiB])
      ) as Record<ResourceTier, number>,
      // idleTimeoutMs is opt-in and we never set it, so nothing here mistakes an
      // outbound-only node-agent for an idle one.
      idleBehaviour: "never",
      // No "start": there is nothing to start. The hub restarts a terminal
      // runtime by provisioning again against the same Volume.
      lifecycle: ["stop", "status"],
    };
  }

  /**
   * Create one sandbox for a runtime, mounting that runtime's durable Volume.
   *
   * Called for a first provision and for every recreation alike — there is no
   * separate "start". Both refusals below happen BEFORE the substrate is
   * touched, so a rejected spec cannot leave a paid, empty Volume behind with
   * no runtime row pointing at it.
   */
  async provision(spec: ProvisionSpec): Promise<{ externalId: string; runtime?: string }> {
    // Modal pulls from a registry. A bare local tag — which is the default a
    // Docker-first hub hands out — produces a sandbox that never boots and a
    // runtime that sits in `provisioning` until the sweeper expires it, with
    // nothing anywhere naming the cause.
    if (!spec.image.includes("/")) {
      throw new Error(
        `modal: image "${spec.image}" is not a registry reference Modal can pull ` +
          `(no registry host). Push a linux/amd64 image and set ` +
          `NODE_AGENT_MODAL_IMAGE — see docs/DEPLOYMENT.md.`
      );
    }

    // Unreachable through the typed API, reachable from a DB row written before
    // a tier was renamed. Without this the lookup yields undefined and the
    // sandbox is sized by Modal's defaults instead of by the operator's choice.
    const tier = MODAL_RESOURCE_TIERS[spec.resourceTier];
    if (!tier) {
      throw new Error(`modal: unsupported resource tier "${spec.resourceTier}"`);
    }

    const volumeName = volumeNameFor(spec.runtimeId);
    const { sandboxId } = await this.api.createSandbox({
      appName: this.appName,
      image: spec.image,
      // Created if missing, re-attached if not: the same runtime id always
      // reaches the same workspace, which is what makes a rolling series of
      // sandboxes look like one durable runtime. Derived from the RUNTIME id,
      // never from the sandbox or the name — a volume keyed to anything that
      // changes across recreation loses the workspace on every restart, and
      // loses it silently.
      volumeName,
      mountPath: MODAL_WORKSPACE_PATH,
      workdir: MODAL_WORKSPACE_PATH,
      command: MODAL_ENTRYPOINT,
      // The token lives here and only here — never in the Volume, never in a
      // log. Each sandbox enrols with a freshly minted one.
      env: {
        AGENTPOD_HUB_URL: spec.hubUrl,
        AGENTPOD_ENROLL_TOKEN: spec.enrollToken,
      },
      cpu: tier.cpu,
      memoryMiB: tier.memoryMiB,
      // Load-bearing, not tidy: Modal's default is FIVE MINUTES. This is the
      // same number the manifest declares, so the rotation sweeper and the
      // platform's own kill clock cannot disagree. And deliberately no
      // idleTimeoutMs — idle reaping is opt-in, and opting in would reap a busy
      // station whose agent only ever dials out.
      timeoutMs: this.maxLifetimeMs,
    });

    return {
      externalId: encodeExternalId(volumeName, sandboxId),
      runtime: "modal-sandbox",
    };
  }

  /**
   * Permanently remove the runtime: the sandbox, and then the Volume that
   * outlives sandboxes.
   *
   * BOTH, always. Unlike stop(), which must never touch the Volume because the
   * Volume is the runtime's identity, destroy() must take it: a Modal Volume
   * exists independently of any sandbox and bills for as long as it exists, so
   * one left behind is a permanent charge for a runtime the operator has been
   * told is gone, with no console row left that could even name it.
   *
   * ORDER: terminate first, delete second. Deleting a Volume still mounted by a
   * live sandbox is a race Modal is under no obligation to make pleasant, and
   * the ordering also decides what a partial failure leaves behind. Terminate
   * first and the worst interruption leaves sandbox down / volume present /
   * externalId still on the row — the cheap half surviving, addressable, and
   * retryable. Reversed, the same interruption leaves compute running against a
   * workspace that has been deleted underneath it: the larger bill, plus a
   * runtime that can no longer be made whole.
   *
   * Only ModalNotFoundError is tolerated, and it is tolerated on BOTH steps
   * rather than one:
   *
   *   - on the terminate, because the 24-hour ceiling reaps a sandbox per
   *     runtime per day, so "the sandbox is already gone and only the billing
   *     Volume is left" is the ordinary case, not an edge one;
   *   - on the delete, because that is what makes the retry converge.
   *
   * Nothing else is tolerated. destroyRuntime() turns a throw into a 502 and
   * leaves the row un-destroyed with its externalId intact, which is exactly
   * what a retry needs; whereas a destroy that resolved on an expired token or
   * a connection reset would have the hub write `destroyed`, forget the
   * externalId, and strand a Volume that bills for ever with nothing anywhere
   * that can address it. The retry therefore converges: a re-terminate of an
   * already-terminated sandbox is a no-op (or a tolerated not-found), and the
   * delete is attempted again until the substrate accepts it.
   *
   * decodeExternalId() throwing is load-bearing here for the same reason. With
   * not-found tolerated on both calls, the codec is the ONLY thing preventing a
   * malformed or half-empty id from addressing nothing, having both not-founds
   * swallowed, and reporting a successful destroy that deleted nothing — which
   * is the leak the Fly driver shipped.
   */
  async destroy(externalId: string): Promise<void> {
    const { volumeName, sandboxId } = decodeExternalId(externalId);

    try {
      await this.api.terminateSandbox(sandboxId);
    } catch (err) {
      if (!(err instanceof ModalNotFoundError)) throw err;
    }

    try {
      await this.api.deleteVolume(volumeName);
    } catch (err) {
      if (!(err instanceof ModalNotFoundError)) throw err;
    }
  }

  /**
   * Terminate the sandbox. IRREVERSIBLE — Modal has no start verb.
   *
   * The Volume is deliberately untouched: it is the runtime's identity, and the
   * hub restarts a terminal runtime by provisioning a NEW sandbox against the
   * same volume (see reprovisionRuntime in ../runtimes.ts). A stop that also
   * deleted the volume would make every stop a destroy — the Cloudflare
   * workspace loss in a new costume, with the button labelled Stop.
   *
   * Only "already gone" is tolerated. stopRuntime() writes `stopping` once this
   * resolves and then trusts status() for the rest, so a stop() that resolved
   * on a connection reset would hand a still-running sandbox to a path built to
   * confirm one that is not.
   */
  async stop(externalId: string): Promise<void> {
    const { sandboxId } = decodeExternalId(externalId);
    try {
      await this.api.terminateSandbox(sandboxId);
    } catch (err) {
      // Already gone is the state the caller asked for — and on this substrate
      // it is routine, since the 24-hour ceiling reaps a sandbox a day whether
      // or not anyone pressed Stop. Anything else is real and must surface.
      if (err instanceof ModalNotFoundError) return;
      throw err;
    }
  }

  /**
   * Ask Modal whether this sandbox is still running.
   *
   * This is the hub's ONLY evidence for writing the runtime status `stopped`,
   * which an operator reads as "it has stopped costing me money" (PR #260/#261
   * exists because `stopped` was once written merely because a driver call
   * returned). The mapping is therefore deliberate in all four directions:
   *
   *   poll() === null        → "running".  Modal's own live/finished signal.
   *   poll() === <exit code> → "stopped".  ANY exit code, INCLUDING 0. `0` is a
   *                            valid exit code and is falsy, so this compares
   *                            against null explicitly; a truthiness test would
   *                            report the one cleanly-finished sandbox as
   *                            running, leave its stop unconfirmed, and flip the
   *                            runtime to `error` five minutes later. This is
   *                            also the 24-hour-ceiling case: at the driver
   *                            level "stopped" means exactly "this sandbox is
   *                            not running", which is true however it ended.
   *   ModalNotFoundError     → "stopped".  An ANSWER, not a silence: an
   *                            authenticated call reached Modal and Modal
   *                            asserted no such sandbox exists in this
   *                            workspace. Nothing that does not exist is
   *                            running or billing. `unknown` would send every
   *                            stop of an already-reaped sandbox — one per
   *                            runtime per day here — through
   *                            sweepStalledRuntimeStops' five-minute timeout
   *                            and out as `error`, an alarm about a bill nobody
   *                            is paying.
   *   anything else          → rethrow.  NEVER "stopped". An expired
   *                            MODAL_TOKEN_SECRET fails every call at once, so
   *                            laundering errors into "stopped" would report
   *                            every Modal runtime in the fleet as stopped
   *                            simultaneously while all of them keep running
   *                            and billing. probeState() in ../runtimes.ts logs
   *                            the throw and degrades it to `unknown`, which the
   *                            sweeper escalates to `error` — loud, and correct.
   */
  async status(externalId: string): Promise<RuntimeState> {
    const { sandboxId } = decodeExternalId(externalId);
    try {
      const exitCode = await this.api.pollSandbox(sandboxId);
      return exitCode === null ? "running" : "stopped";
    } catch (err) {
      if (err instanceof ModalNotFoundError) return "stopped";
      throw err;
    }
  }
}
