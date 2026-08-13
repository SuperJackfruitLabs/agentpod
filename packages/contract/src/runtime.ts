import { z } from "zod";

/**
 * A provider name, not a closed set of them.
 *
 * This was `z.enum(["docker", "cloudflare"])`, which made every new driver a
 * three-package edit — contract, hub, console — before it could even be named.
 * The registry is the authority on which providers exist now: a driver declares
 * itself with a DriverManifest and the hub serves that list.
 *
 * Widening the wire format does NOT widen what the hub accepts. `createRuntime`
 * still refuses a provider that is not registered and enabled, and the route
 * turns that into a 400 — see the unregistered-provider test in
 * apps/hub/src/routes/runtimes.test.ts. What changed is where the "no such
 * provider" answer comes from: the registry, which knows, instead of an enum
 * copied into three packages, which goes stale.
 */
export const RuntimeProvider = z.string().min(1);
export type RuntimeProvider = z.infer<typeof RuntimeProvider>;

/**
 * `starting` — the substrate accepted a start request and no node has arrived
 * yet. It is NOT `online`: `online` means a node for this runtime is connected,
 * which only enrolment can establish. A start that never produces a node times
 * out into `error` with a reason, so "started but never came back" — the most
 * common way a provisioned runtime fails — is a state the console can show.
 *
 * `stopping` — the substrate accepted a stop request and has not yet confirmed
 * the container is down. The mirror image of `starting`, and it exists for the
 * same reason: `stopped` is what an operator reads as "it has stopped costing
 * me money", so it may only be written on the substrate's own evidence. A stop
 * that is never confirmed times out into `error` with a reason, because the
 * absence of a node proves nothing — nodes go offline while containers bill on.
 *
 * `asleep` — the substrate idled the runtime out and stopped billing it. Its
 * node is legitimately offline; the runtime is healthy and can be woken.
 * Distinct from `stopped`, which means an operator stopped it deliberately.
 */
export const RuntimeStatus = z.enum(["provisioning", "starting", "online", "stopping", "stopped", "asleep", "error", "destroyed"]);
export type RuntimeStatus = z.infer<typeof RuntimeStatus>;

export const ResourceTier = z.enum(["small", "medium", "large"]);
export type ResourceTier = z.infer<typeof ResourceTier>;

/**
 * Values must match the node-agent descriptor's `Harness()` string exactly:
 * auto-adoption pairs a provisioned runtime with its detected station by
 * string equality on this field.
 */
export const RuntimeHarness = z.enum(["none", "opencode", "pi"]);
export type RuntimeHarness = z.infer<typeof RuntimeHarness>;

// ─── Harness resource requirements ───────────────────────────────────────────

/**
 * Peak memory each harness needs, in MB. THE place this number is stated.
 *
 * It lives in the contract because three parties need the same answer: the
 * driver that sizes a machine, the hub that refuses an impossible request, and
 * the console that must not offer one. Scattering it produced exactly the
 * failure below — a tier list advertised per PROVIDER, with no regard for the
 * harness that has to fit inside it.
 *
 * opencode — 2048. MEASURED on a Fly `small` machine (1024 MB provisioned,
 * 962 MB usable) on 2026-08-13, running the fleet's `opencode` image:
 *
 *   - Idle, before any work: `opencode serve` alone at 321 MB RSS; 478 MB used
 *     across the whole machine, 483 MB available. So ~157 MB is the OS and the
 *     node-agent beneath the harness.
 *   - During ONE chat turn: a SECOND `opencode` process appears at 251 MB while
 *     the first grows to 604 MB — 855 MB of harness, 58 MB available, load 1.38
 *     on one shared CPU. Whole-machine usage ~1012 MB against a 1024 MB
 *     ceiling with no swap.
 *   - Observed result: `POST /api/stations/:id/acp/sessions` 502 after 34s.
 *
 * One turn therefore consumes the entire machine. The number here is 2048 and
 * not 1024: a requirement equal to the measured peak is not a requirement, it
 * is a coin toss — the machine survived some turns and wedged when health,
 * files and posture/scan requests landed during one. 2 GB is the smallest tier
 * that leaves the harness's own peak in headroom.
 *
 * Docker saw the same shape from the other side on 2026-08-09: an opencode ACP
 * session OOM-killed at 513 MB RSS inside a 512m cgroup, which is why Docker's
 * `small` was raised to 1g. The peak is a property of the harness, not of Fly.
 *
 * pi — 0, because nobody has measured it. An unmeasured requirement must not be
 * invented: every other claim in the manifest is evidence-only, and a number
 * guessed here would refuse a combination that may work perfectly well. Measure
 * it, then put the measurement (not a guess) in this table.
 */
export const HARNESS_MIN_MEMORY_MB: Record<RuntimeHarness, number> = {
  none: 0,
  opencode: 2048,
  pi: 0,
};

/**
 * How much memory a provider's tier actually gives, in MB, as its driver
 * declares it. Partial: a driver declares the tiers it supports and no others.
 */
export const TierMemoryMb = z.partialRecord(ResourceTier, z.number().int().positive());
export type TierMemoryMb = z.infer<typeof TierMemoryMb>;

/** Which of a provider's tiers each harness can actually run in. */
export const HarnessTiers = z.partialRecord(RuntimeHarness, z.array(ResourceTier));
export type HarnessTiers = z.infer<typeof HarnessTiers>;

/**
 * Can this harness run in a tier that gives `tierMemoryMb` of memory?
 *
 * `undefined` memory means the driver has not declared what the tier gives, and
 * the answer is yes — the manifest is evidence-only, so an undeclared number
 * may not be turned into a refusal.
 */
export function tierFitsHarness(harness: string, tierMemoryMb: number | undefined): boolean {
  const required = HARNESS_MIN_MEMORY_MB[harness as RuntimeHarness] ?? 0;
  if (required === 0) return true;
  if (tierMemoryMb === undefined) return true;
  return tierMemoryMb >= required;
}

/**
 * The tiers of one provider that a given harness can actually run in.
 *
 * May legitimately be empty: a substrate fixed at one small instance type
 * (Cloudflare bakes `instance_type` into the worker at deploy) cannot run
 * opencode at all, and the honest answer is "none of them" rather than a choice
 * that fails after provisioning, volume mount and enrolment all look healthy.
 */
export function viableTiersForHarness(
  harness: string,
  supportedTiers: readonly ResourceTier[],
  tierMemoryMb: TierMemoryMb | undefined
): ResourceTier[] {
  return supportedTiers.filter((tier) => tierFitsHarness(harness, tierMemoryMb?.[tier]));
}

/**
 * The whole (harness, tier) viability matrix for one provider.
 *
 * Computed hub-side and served in the manifest so the console filters on the
 * hub's answer instead of re-deriving it from a copy of the requirements that
 * was frozen into a bundle at its last deploy.
 */
export function harnessTiersFor(
  supportedTiers: readonly ResourceTier[],
  tierMemoryMb: TierMemoryMb | undefined
): Record<RuntimeHarness, ResourceTier[]> {
  const out = {} as Record<RuntimeHarness, ResourceTier[]>;
  for (const harness of RuntimeHarness.options) {
    out[harness] = viableTiersForHarness(harness, supportedTiers, tierMemoryMb);
  }
  return out;
}

/**
 * What one provider's driver declares about itself, as served by
 * `GET /api/runtimes/providers` and consumed by the console.
 *
 * The hub's own `DriverManifest` interface is the authority on what a driver
 * must declare; this is the wire projection of it. Everything except
 * `provider` and `supportedTiers` is optional, because the hub and the console
 * deploy separately: a console must keep working against a hub that predates
 * any field here, and the fields it renders from must be the only ones it
 * requires.
 */
export const RuntimeProviderManifest = z.object({
  provider: z.string().min(1),
  supportedTiers: z.array(ResourceTier),
  /** Memory each supported tier gives, MB — the driver's own measurement. */
  tierMemoryMb: TierMemoryMb.optional(),
  /**
   * Which tiers each harness can be provisioned into, derived hub-side from
   * `tierMemoryMb` and HARNESS_MIN_MEMORY_MB. This is the field the console's
   * tier picker reads: without it the picker offers (harness, tier) pairs that
   * the hub then refuses — or worse, provisions and lets fail under load.
   */
  harnessTiers: HarnessTiers.optional(),
  workspaceStorage: z.enum(["rootfs", "volume", "external-archive"]).optional(),
  stopSemantics: z.enum(["resumable", "terminal"]).optional(),
  maxLifetimeMs: z.number().nullable().optional(),
  imageBinding: z.enum(["per-instance", "fixed"]).optional(),
  idleBehaviour: z.enum(["never", "platform-inbound", "hub-driven"]).optional(),
  lifecycle: z.array(z.enum(["start", "stop", "status"])).optional(),
});
export type RuntimeProviderManifest = z.infer<typeof RuntimeProviderManifest>;

export const ProvisionRequest = z.object({
  provider: RuntimeProvider,
  name: z.string().min(1),
  resourceTier: ResourceTier.default("small"),
  harness: RuntimeHarness.default("none"),
});
export type ProvisionRequest = z.infer<typeof ProvisionRequest>;

export const ProvisionedRuntime = z.object({
  id: z.string(),
  ownerId: z.string(),
  provider: RuntimeProvider,
  externalId: z.string().nullable(),
  status: RuntimeStatus,
  nodeId: z.string().nullable(),
  name: z.string(),
  resourceTier: ResourceTier,
  harness: RuntimeHarness,
  /**
   * Container runtime the provider reports this runtime is running under, e.g.
   * "runsc" for gVisor. Null for providers with no such concept and for rows
   * created before it was recorded — never inferred.
   */
  runtime: z.string().min(1).nullable().optional(),
  /**
   * Why the runtime is in its current status, when the status alone does not
   * say. Set on failures — an `error` that reads "no node enrolled within 2m of
   * the start request" answers the operator's actual question ("why is it not
   * coming back") instead of leaving them to restart something that cannot
   * work. Null/absent whenever there is nothing to explain.
   */
  statusReason: z.string().min(1).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProvisionedRuntime = z.infer<typeof ProvisionedRuntime>;
