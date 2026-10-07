/**
 * Verifying a bearer token at any of the hub's doors.
 *
 * **One verifier, deliberately.** `authMiddleware`, the MCP endpoint, `/api/fleet/dispatchable`
 * and the evidence routes all call `verifyPlaneBearer`, so they cannot drift: two
 * implementations of "is this token one we accept" is precisely how a key accepted in one place
 * comes to be rejected in another, and that failure reads as "you have no permission", which is
 * the hardest kind to trace.
 *
 * The organization plane is the only issuer (contract §1, design §9). The hub's own issuer — Better
 * Auth and its service signing key — was removed after the rollback window (P3 plan, Task 17).
 */
import type { OrgPlaneTokenClaims } from "@agentpod/contract";

import { planeVerifier } from "./org-plane/verify.ts";
import { tenantForOrg } from "./org-plane/tenant.ts";

export type PlaneCaller = {
  sub: string;
  principalKind: "human" | "agent" | "service";
  tenantId: string;
  claims: OrgPlaneTokenClaims;
};
export type PlaneBearerResult =
  | { ok: true; caller: PlaneCaller }
  | { ok: false; status: 401 }
  | { ok: false; status: 403; body: { error: "product_not_enabled"; org: string } };

/**
 * Verification is offline (cached JWKS); the tenant lookup is local. No plane call.
 *
 * `client_id` / `azp` are not read: any valid token for this hub's audience is accepted,
 * whichever first-party client asked for it (contract §3.1). `amr` is never required.
 */
export async function verifyPlaneBearer(
  token: string,
  deps: { verify?: (t: string) => Promise<OrgPlaneTokenClaims | null>; tenantFor?: typeof tenantForOrg } = {},
): Promise<PlaneBearerResult> {
  const claims = await (deps.verify ?? ((t: string) => planeVerifier().verify(t)))(token);
  if (!claims) return { ok: false, status: 401 };
  const tenant = await (deps.tenantFor ?? tenantForOrg)(claims);
  if (!tenant.ok) return { ok: false, status: tenant.status, body: tenant.body };
  return { ok: true, caller: { sub: claims.sub, principalKind: claims.principalKind, tenantId: tenant.tenantId, claims } };
}
