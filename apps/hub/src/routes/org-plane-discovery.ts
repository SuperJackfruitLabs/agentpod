import { Hono } from "hono";
import { orgPlane, type OrgPlaneConfig } from "../auth/org-plane/config";

/** Tells the console and `fleet login` which issuer to use, so neither needs rebuilding at cutover. */
export function createOrgPlaneDiscoveryRoutes(read: () => OrgPlaneConfig | null = orgPlane) {
  return new Hono().get("/org-plane", (c) => {
    const p = read();
    return c.json(p ? { issuer: p.issuer, url: p.url, audience: p.audience } : { issuer: null });
  });
}
