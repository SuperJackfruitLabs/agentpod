/**
 * Admin Middleware
 * 
 * Middleware for protecting admin routes and checking user status.
 */

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { isUserAdmin } from "../models/admin-users";
import { createLogger } from "../utils/logger";

const log = createLogger("admin-middleware");

// =============================================================================
// Types
// =============================================================================

/**
 * Extended context variables for admin routes
 */
export interface AdminContext {
  adminUser: {
    id: string;
    email?: string;
    role: string;
  };
}

// =============================================================================
// Admin Middleware
// =============================================================================

/**
 * Middleware that requires admin role
 * Must be used after authMiddleware
 */
export const adminMiddleware = createMiddleware(async (c, next) => {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Check if user is admin
  const isAdmin = await isUserAdmin(user.id);

  if (!isAdmin) {
    log.warn("Non-admin user attempted to access admin route", {
      userId: user.id,
      email: user.email,
      path: c.req.path,
    });
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  // Store admin context
  c.set("adminUser", {
    id: user.id,
    email: user.email,
    role: "admin",
  });

  return next();
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the admin user from context
 * Throws if not an admin request
 */
export function requireAdmin(c: Context): AdminContext["adminUser"] {
  const adminUser = c.get("adminUser");
  if (!adminUser) {
    throw new Error("Admin context not available. Ensure adminMiddleware is applied.");
  }
  return adminUser;
}

/**
 * Get request metadata for audit logging
 */
export function getRequestContext(c: Context): { ipAddress?: string; userAgent?: string } {
  return {
    ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || undefined,
    userAgent: c.req.header("user-agent") || undefined,
  };
}

/**
 * Check if the current user is an admin (for conditional logic)
 */
export async function checkIsAdmin(c: Context): Promise<boolean> {
  const user = c.get("user");
  if (!user) return false;
  return isUserAdmin(user.id);
}
