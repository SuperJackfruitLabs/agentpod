/**
 * The organization plane's access-token claims (fixtures/ecosystem-identity/token_claims.json v8).
 * Every product verifies against this one shape. Loose: provider-set claims (client_id, azp, sid)
 * pass through and are ignored.
 */
import { z } from "zod";
import { OrganizationId, PrincipalId } from "./ids";

export const ORG_PLANE_PRODUCTS = ["agentpod", "superpipeline", "supermessage", "superwitness"] as const;

export const OrgPlaneTokenClaims = z.looseObject({
  iss: z.string().min(1),
  sub: PrincipalId,
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  exp: z.number().int(),
  iat: z.number().int(),
  jti: z.string().min(1),
  principalKind: z.enum(["human", "agent", "service"]),
  org: OrganizationId,
  // Unrecognised values are ignored, never refused — so not an enum.
  ent: z.array(z.string()),
  // A non-prn_ value is ignored by consumers (valueRules.unrecognisedIsIgnored), so plain strings.
  mayDispatch: z.array(z.string()),
  mayGrantReach: z.boolean(),
  scope: z.string().optional(),
  act: z.object({ sub: PrincipalId }).optional(),
  amr: z.array(z.string()).optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
});
export type OrgPlaneTokenClaims = z.infer<typeof OrgPlaneTokenClaims>;

/** Equals, or contains. Never a prefix match. */
export function audienceIncludes(aud: string | string[], audience: string): boolean {
  return Array.isArray(aud) ? aud.includes(audience) : aud === audience;
}
