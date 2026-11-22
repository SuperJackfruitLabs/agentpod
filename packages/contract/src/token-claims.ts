/**
 * The organization plane's access-token claims (treaty's fixtures/ecosystem-identity/token_claims.json v9),
 * as the hub reads them once treaty's verifier (`verifyAccessToken`, the rules every product shares)
 * has accepted the token. Loose: a claim it does not name passes through and is ignored.
 */
import { z } from "zod";
import { OrganizationId, PrincipalId } from "./ids";

export const ORG_PLANE_PRODUCTS = ["agentpod", "superpipeline", "supermessage", "superwitness", "superlibrary"] as const;

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
  // Plain strings here, as token_claims.json types it. The hub's verifier (treaty's
  // verifyAccessToken) refuses a whole token carrying a non-prn_ value before this schema reads it,
  // so past the verifier every value is a prn_ id.
  mayDispatch: z.array(z.string()),
  mayGrantReach: z.boolean(),
  scope: z.string().optional(),
  act: z.object({ sub: PrincipalId }).optional(),
  amr: z.array(z.string()).optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  // The human's role in `org` (workspace authority spec W1). A plain string, not an enum: a token
  // carrying a value this contract does not know must still verify. Read it through
  // `workspaceRoleOf`, which answers "member" for anything else — absent included.
  orgRole: z.string().optional(),
  // Set by the OAuth provider on OAuth access tokens. Named so the schema and the corpus list the
  // same claims; nothing reads them.
  client_id: z.string().optional(),
  azp: z.string().optional(),
  sid: z.string().optional(),
});
export type OrgPlaneTokenClaims = z.infer<typeof OrgPlaneTokenClaims>;

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * A token's `orgRole` as a role. Absent (a token minted before the issuer spoke it, an agent or a
 * service) and unrecognised values are `member`: the default is the least authority, so an old or
 * unexpected token fails closed rather than open.
 */
export function workspaceRoleOf(orgRole: unknown): WorkspaceRole {
  return orgRole === "owner" || orgRole === "admin" ? orgRole : "member";
}

/** Equals, or contains. Never a prefix match. */
export function audienceIncludes(aud: string | string[], audience: string): boolean {
  return Array.isArray(aud) ? aud.includes(audience) : aud === audience;
}
