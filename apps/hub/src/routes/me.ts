/**
 * `GET /api/me` — who the caller is, and whether they operate this hub.
 *
 * What the console reads under the org plane instead of Better Auth's session and its `role`
 * (`apps/console/src/lib/stores/auth.svelte.ts`, `initAuth`): `{ id, email, isAdmin }`. `email`
 * is the token's `email` claim for a human and null when the token has none; `isAdmin` is the
 * hub's own seat (`hub_operators`, decision D4) under the plane and `user.role` otherwise.
 * `issuer` says which of the two answered. Mounted behind `/api/*`'s authMiddleware.
 */
import { Hono } from "hono";
import { orgPlane } from "../auth/org-plane/config";
import { isUserAdmin } from "../models/admin-users";

export const meRoutes = new Hono().get("/me", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "Unauthorized" }, 401);
  return c.json({
    id: u.id,
    email: u.email ?? null,
    isAdmin: await isUserAdmin(u.id),
    issuer: orgPlane() ? "org-plane" : "hub",
  });
});
