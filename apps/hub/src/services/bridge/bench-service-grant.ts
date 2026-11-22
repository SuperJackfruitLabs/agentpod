/**
 * The hub's own service grant at the SuperPipeline audience: who the checkpoint reporter is and
 * whether it may submit. Exchanged once, verified and dropped; the token is never stored or logged.
 */
import { orgPlane } from "../../auth/org-plane/config";
import { orgPlaneClient } from "../../auth/org-plane/client";
import { createPlaneVerifier } from "../../auth/org-plane/verify";

/** The scopes the checkpoint reporter spends (checkpoint-service-client.ts). */
export const CHECKPOINT_SERVICE_SCOPES = ["checkpoints:submit", "checkpoints:read"] as const;

export type ServiceGrant =
  | { ok: true; sub: string; org: string; entitled: boolean; missing: string[] }
  | { ok: false; error: string };

export async function serviceGrant(audience: string): Promise<ServiceGrant> {
  const cfg = orgPlane();
  let token: string;
  try {
    token = (await orgPlaneClient().serviceToken(audience)).accessToken;
  } catch {
    return { ok: false, error: "the organization plane would not issue the hub a service grant at this audience" };
  }
  const checked = await createPlaneVerifier({ issuer: cfg.issuer, jwksUrl: cfg.jwksUrl, audience, product: "superpipeline" }).check(token);
  if (!checked.ok)
    return { ok: false, error: checked.code === "product_not_enabled" ? "the service grant is not entitled to superpipeline"
      : `the service grant did not verify against the plane's keys and this audience (${checked.code})` };
  const claims = checked.claims;
  if (claims.principalKind !== "service") return { ok: false, error: "the plane did not issue it as a service" };
  const held = new Set(claims.scope?.split(/\s+/) ?? []);
  return { ok: true, sub: claims.sub, org: claims.org, entitled: claims.ent.includes("superpipeline"),
    missing: CHECKPOINT_SERVICE_SCOPES.filter((s) => !held.has(s)) };
}
