import { z } from "zod";
import { PrincipalId, OrganizationId } from "./ids";
/** An operator-selected exchange source, never a caller-supplied bearer token. */
export const BridgeCredentialSource = z
  .object({
    version: z.literal(1),
    kind: z.literal("station-plane"),
    principalId: PrincipalId,
    organizationId: OrganizationId,
    audience: z.literal("https://app.superpipeline.dev"),
  })
  .strict();
export type BridgeCredentialSource = z.infer<typeof BridgeCredentialSource>;
