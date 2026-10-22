/**
 * `GET /api/me` — who the caller is, and what they may do here.
 *
 * `{ id, email, org, workspaceRole, isWorkspaceAdmin, isHubOperator, isAdmin, issuer }`
 * (workspace authority spec, "Hub changes"):
 *
 * - `org` is the workspace the token names (null for the static API_TOKEN, which names none);
 *   `workspaceRole` is the caller's role in it, `member` when the token carries no `orgRole`.
 * - `isWorkspaceAdmin`: owner or admin of that workspace — the fleet's admin actions.
 * - `isHubOperator`: owner/admin of the hub's home workspace (its service credential's org), or a
 *   seat in `hub_operators` (`HUB_OPERATORS`, optional extras) — the hub-wide
 *   settings.
 * - `isAdmin` = `isWorkspaceAdmin || isHubOperator`, kept for a console that reads only it
 *   (`apps/console/src/lib/stores/auth.svelte.ts`, `initAuth`).
 *
 * `email` is the token's `email` claim for a human and null when the token has none. `issuer` is
 * always `"org-plane"`; kept so a console that branches on it keeps working. Mounted behind
 * `/api/*`'s authMiddleware.
 */
import { Hono } from "hono";
import { isHubOperator, isWorkspaceAdmin, workspaceRole } from "../auth/workspace-authority";

export const meRoutes = new Hono().get("/me", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "Unauthorized" }, 401);
  const workspaceAdmin = isWorkspaceAdmin(c);
  const hubOperator = await isHubOperator(c);
  return c.json({
    id: u.id,
    email: u.email ?? null,
    org: u.org ?? null,
    workspaceRole: workspaceRole(c),
    isWorkspaceAdmin: workspaceAdmin,
    isHubOperator: hubOperator,
    isAdmin: workspaceAdmin || hubOperator,
    issuer: "org-plane" as const,
  });
});
