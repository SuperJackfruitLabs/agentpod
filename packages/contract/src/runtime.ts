import { z } from "zod";

export const RuntimeProvider = z.enum(["docker", "cloudflare"]);
export type RuntimeProvider = z.infer<typeof RuntimeProvider>;

/**
 * `asleep` — the substrate idled the runtime out and stopped billing it. Its
 * node is legitimately offline; the runtime is healthy and can be woken.
 * Distinct from `stopped`, which means an operator stopped it deliberately.
 */
export const RuntimeStatus = z.enum(["provisioning", "online", "stopped", "asleep", "error", "destroyed"]);
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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProvisionedRuntime = z.infer<typeof ProvisionedRuntime>;
