/** Proposed server-owned coordinator mapping. No environment loader or production opt-in. */
import { z } from "zod";
import { BenchCoordinatorTarget } from "@agentpod/contract";
import type { PendingCheckpointClaim } from "./checkpoint-claim";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?![\s\S])/);
const principal = z.string().regex(/^prn_[a-f0-9]{20}(?![\s\S])/);
const sha = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
const endpoint = z.string().refine((value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash &&
      u.origin === value;
  } catch { return false; }
});
const profileSchema = z.object({
  version: z.literal("agentpod.checkpoint-profile.v1"),
  organizationId: z.string().regex(/^org_[a-f0-9]{20}(?![\s\S])/),
  sourceTenantId: id, sourceOrigin: endpoint, sourceAudience: endpoint,
  reporterPrincipalId: principal, ownerPrincipalId: principal, occupantPrincipalId: principal,
  agentKey: id, profileKey: id, occupancyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  target: BenchCoordinatorTarget,
  repositories: z.array(z.object({ name, repositorySHA256: sha,
    provider: z.enum(["forge", "github"]), repository: z.string().max(200)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/),
    objectFormat: z.enum(["sha1", "sha256"]),
  }).strict()).min(1).max(32),
  checkpointRepository: name,
}).strict().refine((value) => value.repositories.every((member, index) => index === 0 ||
  (value.repositories[index - 1]?.name ?? "") < member.name) &&
  value.repositories.some((member) => member.name === value.checkpointRepository) &&
  new Set(value.repositories.map((member) => member.repositorySHA256)).size === value.repositories.length &&
  new Set(value.repositories.map((member) => member.provider + "/" + member.repository)).size === value.repositories.length);
export type CheckpointProfile = z.infer<typeof profileSchema>;
export class CheckpointRefused extends Error {
  constructor(readonly code: "invalid" | "authority" | "unavailable" | "uncertain" | "source" | "stale") {
    super(`Checkpoint refused: ${code}`);
    this.name = "CheckpointRefused";
  }
}
/** Only server configuration enters here; node fields, handoff and claim JSON never define this mapping. */
export function parseCheckpointProfile(value: unknown): CheckpointProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new CheckpointRefused("invalid");
  // A deep snapshot prevents post-await mutation of repository or identity pins.
  for (const member of parsed.data.repositories) Object.freeze(member);
  Object.freeze(parsed.data.repositories);
  Object.freeze(parsed.data.target);
  return Object.freeze(parsed.data);
}
export function requireCheckpointProfileClaim(profile: CheckpointProfile, claim: PendingCheckpointClaim): void {
  const t = profile.target; const p = claim.policy;
  if (claim.tenantId !== profile.sourceTenantId || claim.boardId !== t.board_id || claim.agentId !== t.agent_id ||
    p.reporterPrincipalId !== profile.reporterPrincipalId || p.nodeId !== t.node_id ||
    p.checkpointRepository !== profile.checkpointRepository ||
    !p.executors.some((executor) => executor.agentId === t.agent_id && executor.stationId === t.station_id) ||
    p.repositories.length !== profile.repositories.length || p.repositories.some((member, index) => {
      const pin = profile.repositories[index];
      return pin?.name !== member.name || pin.provider !== member.provider || pin.repository !== member.repository;
    })) throw new CheckpointRefused("authority");
}
