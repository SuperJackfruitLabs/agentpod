/**
 * What the hub stops doing when `ORG_PLANE_*` is set: 410, not 404 — each route existed and
 * moved, and the body says where. In legacy mode every middleware here calls `next()` and
 * nothing changes.
 *
 * Two bodies, because two different things moved:
 *
 * - `{ error: "issuer_moved", issuer }` — the hub mints nothing and serves no key set (contract
 *   §4). Every `/api/auth/*` route: jwks, authorize, token exchange, device token, service
 *   token and Better Auth's sign-in/sign-up/session.
 * - `{ error: "managed_by_org_plane", url }` — a record the plane now owns: the device inventory
 *   (`/api/auth/devices`, `/api/auth/devices/:id`) and the admin routes of decision D3 (users,
 *   signup, grants, service principals, suspend/restore). `fleet devices` and the console
 *   read `url` to send the person there.
 */
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { orgPlane, type OrgPlaneConfig } from "./config";

/** The one shape for "the plane owns this now". */
export function managedByOrgPlane(c: Context, plane: OrgPlaneConfig) {
  return c.json({ error: "managed_by_org_plane", url: plane.url }, 410);
}

/** The device inventory, not its token exchange (`/api/auth/devices/token` is issuing). */
const DEVICE_INVENTORY = /^\/api\/auth\/devices(\/(?!token$)[^/]+)?\/?$/;

export function retiredIssuerRoutes(plane: () => OrgPlaneConfig | null = orgPlane) {
  return createMiddleware(async (c, next) => {
    const p = plane();
    if (!p) return next();
    if (DEVICE_INVENTORY.test(c.req.path)) return managedByOrgPlane(c, p);
    return c.json({ error: "issuer_moved", issuer: p.issuer }, 410);
  });
}

/** Decision D3. `GET /api/admin/principals` is not here: it stays, read through the plane. */
const RETIRED_ADMIN: Array<[method: string | null, pattern: RegExp]> = [
  [null, /^\/api\/admin\/users(\/|$)/],
  [null, /^\/api\/admin\/settings\/signup(\/|$)/],
  [null, /^\/api\/admin\/grants(\/|$)/],
  [null, /^\/api\/admin\/service-principals(\/|$)/],
  ["POST", /^\/api\/admin\/principals\/[^/]+\/(suspend|restore)\/?$/],
];

/**
 * Registered first in `adminRouter`, ahead of its `authMiddleware`: a retired route need not
 * authenticate to say it moved.
 */
export function retiredUnderPlane(plane: () => OrgPlaneConfig | null = orgPlane) {
  return createMiddleware(async (c, next) => {
    const p = plane();
    if (!p) return next();
    const hit = RETIRED_ADMIN.some(([m, re]) => (m === null || m === c.req.method) && re.test(c.req.path));
    return hit ? managedByOrgPlane(c, p) : next();
  });
}
