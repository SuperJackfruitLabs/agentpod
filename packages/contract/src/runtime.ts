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
