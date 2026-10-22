/**
 * Who may do what, in the workspace the request acts in (workspace authority spec, 2026-10-22).
 *
 * Two authorities, and neither implies the other:
 *
 * - **Workspace admin** (W1): the caller's `orgRole` in the token's `org` is `owner` or `admin`.
 *   It gates everything a workspace owns — enrolling, removing and updating its nodes, its agents,
 *   its bridge roster, its audit log. It is read from the token on every request; the hub keeps no
 *   copy, and a token without `orgRole` is a member (fails closed).
 * - **Hub operator** (W2): a seat in `hub_operators`, set from `HUB_OPERATORS` at boot (W3). It
 *   gates only what no single workspace owns: the hub-wide provider settings, and reads that span
 *   tenants. A hub operator is NOT an admin of any workspace by holding the seat; in a workspace
 *   they are whatever their token's role says.
 *
 * The static API_TOKEN is both: it is the hub's own key, held by whoever runs the hub, and it acts
 * in the bootstrap tenant (auth/middleware.ts sets `workspaceRole: "admin"`).
 */
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { WorkspaceRole } from "@agentpod/contract";

import { isUserAdmin } from "../models/admin-users";
import { createLogger } from "../utils/logger";
import type { AuthUser } from "./middleware";

const log = createLogger("workspace-authority");

export const WORKSPACE_ADMIN_REQUIRED = { error: "workspace_admin_required" } as const;

function callerOf(c: Context): AuthUser | undefined {
  const u = c.get("user") as AuthUser | undefined;
  return u && u.id !== "anonymous" ? u : undefined;
}

/** The caller's role in the request's workspace; `member` when nothing says otherwise. */
export function workspaceRole(c: Context): WorkspaceRole {
  return roleOf(callerOf(c));
}

/** The same answer for an `AuthUser` in hand (services that are passed the caller, not a context). */
export function roleOf(user: Pick<AuthUser, "workspaceRole"> | undefined): WorkspaceRole {
  const r = user?.workspaceRole;
  return r === "owner" || r === "admin" ? r : "member";
}

export function isWorkspaceAdminUser(user: Pick<AuthUser, "workspaceRole"> | undefined): boolean {
  return roleOf(user) !== "member";
}

/** Owner or admin of the workspace this request acts in. */
export function isWorkspaceAdmin(c: Context): boolean {
  return isWorkspaceAdminUser(callerOf(c));
}

/**
 * Null when the caller is a workspace admin; otherwise the response to return — 401 with no
 * caller, 403 `{ error: "workspace_admin_required" }` for anyone else.
 */
export function requireWorkspaceAdmin(c: Context): Response | null {
  const user = callerOf(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (isWorkspaceAdminUser(user)) return null;
  log.warn("workspace admin required", { userId: user.id, path: c.req.path });
  return c.json(WORKSPACE_ADMIN_REQUIRED, 403);
}

/** Does the caller hold this hub's operator seat? The static API_TOKEN always does. */
export async function isHubOperator(c: Context): Promise<boolean> {
  const user = callerOf(c);
  if (!user) return false;
  if (user.authType === "api_key") return true;
  return isUserAdmin(user.id);
}

/** `requireWorkspaceAdmin` as middleware. */
export const workspaceAdminMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  const refused = requireWorkspaceAdmin(c);
  if (refused) return refused;
  return next();
});

/** The hub operator seat as middleware: the hub-wide settings. */
export const hubOperatorMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  const user = callerOf(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!(await isHubOperator(c))) {
    log.warn("hub operator required", { userId: user.id, path: c.req.path });
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  return next();
});
