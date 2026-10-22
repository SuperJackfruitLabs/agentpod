/**
 * Request metadata for the admin audit log.
 *
 * The admin guard that used to live here (`adminMiddleware`, the `hub_operators` seat for every
 * admin route) was split in two by the workspace authority spec (2026-10-22): see
 * `auth/workspace-authority.ts` — `workspaceAdminMiddleware` for what a workspace owns,
 * `hubOperatorMiddleware` for what the whole hub owns.
 */

import type { Context } from "hono";

/**
 * Get request metadata for audit logging
 */
export function getRequestContext(c: Context): { ipAddress?: string; userAgent?: string } {
  return {
    ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || undefined,
    userAgent: c.req.header("user-agent") || undefined,
  };
}
