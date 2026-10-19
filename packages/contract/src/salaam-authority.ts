import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const SalaamRunAuthority = z
  .object({
    source: z.enum(["agentpod", "superpipeline"]),
    id,
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
/** Issued by the authenticated Hub/node control path, never ACP prompt metadata. */
export const SalaamAuthority = z
  .object({
    version: z.literal(1),
    organization_id: z.string().regex(/^org_[a-f0-9]{20}$/),
    principal_id: z.string().regex(/^prn_[a-f0-9]{20}$/),
    node_id: id,
    station_id: id,
    station_key: z.string().regex(/^salaam:[a-f0-9]{16}$/),
    occupancy_epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    hub_session_id: id,
    workspace: z
      .string()
      .min(1)
      .max(4096)
      .startsWith("/")
      .refine((s) => !s.includes("\0")),
    run: SalaamRunAuthority,
  })
  .strict();
export type SalaamAuthority = z.infer<typeof SalaamAuthority>;
export type SalaamRunAuthority = z.infer<typeof SalaamRunAuthority>;

export const SalaamAuthorityParams = z
  .object({
    binding: SalaamAuthority,
    request_id: id,
    lease_sequence: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    reason: z.string().min(1).max(1024).optional(),
  })
  .strict();
export const SalaamAuthorityStatus = z.object({
  admission_id: z.string().uuid(),
  session_id: z.string().uuid(),
  binding: SalaamAuthority,
  binding_digest: z.string(),
  lease_sequence: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  authorized: z.boolean(),
  revoked: z.boolean(),
  owned_execution_stopped: z.boolean(),
  unresolved_operations: z.array(z.string()),
  active_attempts: z.array(z.string()),
  interrupted_attempts: z.array(z.string()),
});
