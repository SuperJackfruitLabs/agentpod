import { Hono } from "hono";
import { orgPlane, type OrgPlaneConfig } from "../auth/org-plane/config";

/**
 * Tells the console and `fleet login` which issuer to use, so neither needs rebuilding at cutover.
 * Always the plane's now (P3 plan, Task 17): the `{ issuer: null }` answer meant "the hub is its
 * own issuer", and that hub is gone.
 */
export function createOrgPlaneDiscoveryRoutes(read: () => OrgPlaneConfig = orgPlane) {
  return new Hono().get("/org-plane", (c) => {
    const p = read();
    return c.json({ issuer: p.issuer, url: p.url, audience: p.audience });
  });
}
