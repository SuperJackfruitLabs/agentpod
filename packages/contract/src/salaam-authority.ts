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

/** An agent's standing "Always allow" rule, set by a workspace owner or admin (approval scopes).
 * v1 has one scope: workspace writes. Salaam never lets it cover deletes, hidden paths, commands,
 * network or anything outside the workspace. */
export const SalaamApprovalRule = z
  .object({
    id: z.string().uuid(),
    scope: z.literal("workspace-write"),
    set_by: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/),
  })
  .strict();
export type SalaamApprovalRule = z.infer<typeof SalaamApprovalRule>;
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
    /**
     * Admit only: the hub session id of an earlier, revoked interactive admission whose
     * conversation this one carries on (a resume). The new admission still gets its own session,
     * lease and authority; Salaam refuses unless the earlier one is stopped and reconciled.
     */
    continue_from: id.optional(),
    /** Admit and renew: the agent's active rules. Salaam pins them at admission and drops each at
     * the first renewal that no longer lists it, so revoking a rule applies to a run in flight.
     * Absent means none. */
    approval_rules: z
      .array(SalaamApprovalRule)
      .min(1)
      .max(16)
      .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, "duplicate rule")
      .optional(),
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
  /** The hub session id this admission continued, null when it started fresh. Absent from an
   * older Salaam, which cannot continue a conversation. */
  continued_from: z.string().nullable().optional(),
});
