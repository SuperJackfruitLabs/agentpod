/**
 * Admin API Routes
 * 
 * Endpoints for admin functionality:
 * - User management (list, view, ban/unban)
 * - Resource limits management
 * - System statistics
 * - Audit log viewing
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { adminMiddleware, getRequestContext } from "../auth/admin-middleware";
import { authMiddleware } from "../auth/middleware";
import { createLogger } from "../utils/logger";
import { adminGrantsRouter } from "./admin-grants";
import { adminPrincipalsRouter } from "./admin-principals";

// Models
import {
  listUsers,
  getUserById,
  banUser,
  unbanUser,
  updateUserRole,
  getAdminStats,
  type ListUsersOptions,
} from "../models/admin-users";
import {
  getAuditLogs,
  logUserBan,
  logUserUnban,
  logRoleChange,
} from "../models/admin-audit-log";

const log = createLogger("admin-routes");

// =============================================================================
// Router Setup
// =============================================================================

export const adminRouter = new Hono();

// Apply auth middleware to all admin routes
adminRouter.use("*", authMiddleware);
adminRouter.use("*", adminMiddleware);

// The control pair's grants, mounted inside the same guard. Without an HTTP
// surface the control is operable only by someone with a database client, and
// an authorization system nobody can inspect is one people route around.
adminRouter.route("/grants", adminGrantsRouter);

// The vocabulary those grants are written in. A grant names a `prn_` id on both
// sides and nothing else in this API says what those ids are, so without this
// the console can offer only a text box for a twenty-hex string.
adminRouter.route("/principals", adminPrincipalsRouter);

// =============================================================================
// Validation Schemas
// =============================================================================

const listUsersSchema = z.object({
  search: z.string().optional(),
  role: z.enum(["user", "admin"]).optional(),
  banned: z.enum(["true", "false"]).optional().transform(v => v === "true" ? true : v === "false" ? false : undefined),
  limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 25),
  offset: z.string().optional().transform(v => v ? parseInt(v, 10) : 0),
  sortBy: z.enum(["email", "name", "createdAt", "role"]).optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
});

const banUserSchema = z.object({
  reason: z.string().min(1, "Reason is required").max(500),
});

const updateRoleSchema = z.object({
  role: z.enum(["user", "admin"]),
});

const auditLogSchema = z.object({
  adminUserId: z.string().optional(),
  targetUserId: z.string().optional(),
  action: z.string().optional(),
  startDate: z.string().optional().transform(v => v ? new Date(v) : undefined),
  endDate: z.string().optional().transform(v => v ? new Date(v) : undefined),
  limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 50),
  offset: z.string().optional().transform(v => v ? parseInt(v, 10) : 0),
});

// =============================================================================
// User Management Routes
// =============================================================================

/**
 * GET /admin/users
 * List all users with pagination and filters
 */
adminRouter.get("/users", zValidator("query", listUsersSchema), async (c) => {
  const query = c.req.valid("query");
  
  log.info("Admin listing users", { query });

  const options: ListUsersOptions = {
    search: query.search,
    role: query.role,
    banned: query.banned,
    limit: query.limit,
    offset: query.offset,
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
  };

  const result = await listUsers(options);

  return c.json({
    users: result.users,
    total: result.total,
    limit: query.limit,
    offset: query.offset,
    page: Math.floor((query.offset ?? 0) / (query.limit ?? 25)) + 1,
    totalPages: Math.ceil(result.total / (query.limit ?? 25)),
  });
});

/**
 * GET /admin/users/:id
 * Get detailed user info including limits
 */
adminRouter.get("/users/:id", async (c) => {
  const userId = c.req.param("id");

  const user = await getUserById(userId);

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    user,
  });
});

/**
 * POST /admin/users/:id/ban
 * Ban a user
 */
adminRouter.post("/users/:id/ban", zValidator("json", banUserSchema), async (c) => {
  const targetUserId = c.req.param("id");
  const { reason } = c.req.valid("json");
  const adminUser = c.get("user");
  const ctx = getRequestContext(c);

  // Prevent self-ban
  if (targetUserId === adminUser.id) {
    return c.json({ error: "Cannot ban yourself" }, 400);
  }

  // Check if user exists
  const targetUser = await getUserById(targetUserId);
  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  // Prevent banning other admins (optional - remove if admins should be able to ban each other)
  if (targetUser.role === "admin") {
    return c.json({ error: "Cannot ban another admin" }, 400);
  }

  // Ban the user
  const result = await banUser(targetUserId, reason);
  if (!result) {
    return c.json({ error: "Failed to ban user" }, 500);
  }

  // Log the action
  await logUserBan(adminUser.id, targetUserId, reason, ctx.ipAddress, ctx.userAgent);

  log.info("User banned", {
    adminUserId: adminUser.id,
    targetUserId,
    reason,
  });

  return c.json({ 
    success: true, 
    message: "User banned successfully",
    user: await getUserById(targetUserId),
  });
});

/**
 * POST /admin/users/:id/unban
 * Unban a user
 */
adminRouter.post("/users/:id/unban", async (c) => {
  const targetUserId = c.req.param("id");
  const adminUser = c.get("user");
  const ctx = getRequestContext(c);

  // Check if user exists
  const targetUser = await getUserById(targetUserId);
  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!targetUser.banned) {
    return c.json({ error: "User is not banned" }, 400);
  }

  // Unban the user
  const result = await unbanUser(targetUserId);
  if (!result) {
    return c.json({ error: "Failed to unban user" }, 500);
  }

  // Log the action
  await logUserUnban(adminUser.id, targetUserId, ctx.ipAddress, ctx.userAgent);

  log.info("User unbanned", { adminUserId: adminUser.id, targetUserId });

  return c.json({ 
    success: true, 
    message: "User unbanned successfully",
    user: await getUserById(targetUserId),
  });
});

/**
 * PUT /admin/users/:id/role
 * Update user role
 */
adminRouter.put("/users/:id/role", zValidator("json", updateRoleSchema), async (c) => {
  const targetUserId = c.req.param("id");
  const { role: newRole } = c.req.valid("json");
  const adminUser = c.get("user");
  const ctx = getRequestContext(c);

  // Prevent self-demotion
  if (targetUserId === adminUser.id && newRole !== "admin") {
    return c.json({ error: "Cannot demote yourself" }, 400);
  }

  // Check if user exists
  const targetUser = await getUserById(targetUserId);
  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (targetUser.role === newRole) {
    return c.json({ error: `User already has role '${newRole}'` }, 400);
  }

  // Update role
  const result = await updateUserRole(targetUserId, newRole);
  if (!result) {
    return c.json({ error: "Failed to update role" }, 500);
  }

  // Log the action
  await logRoleChange(adminUser.id, targetUserId, result.oldRole, newRole, ctx.ipAddress, ctx.userAgent);

  log.info("User role updated", { 
    adminUserId: adminUser.id, 
    targetUserId, 
    oldRole: result.oldRole, 
    newRole,
  });

  return c.json({ 
    success: true, 
    message: `User role updated to '${newRole}'`,
    user: await getUserById(targetUserId),
  });
});

// =============================================================================
// Statistics Routes
// =============================================================================

/**
 * GET /admin/stats
 * Get system-wide statistics
 */
adminRouter.get("/stats", async (c) => {
  const stats = await getAdminStats();
  return c.json(stats);
});

// =============================================================================
// Audit Log Routes
// =============================================================================

/**
 * GET /admin/audit-log
 * Get admin audit log entries
 */
adminRouter.get("/audit-log", zValidator("query", auditLogSchema), async (c) => {
  const query = c.req.valid("query");

  const result = await getAuditLogs({
    adminUserId: query.adminUserId,
    targetUserId: query.targetUserId,
    action: query.action as any,
    startDate: query.startDate,
    endDate: query.endDate,
    limit: query.limit,
    offset: query.offset,
  });

  return c.json({
    entries: result.entries,
    total: result.total,
    limit: query.limit,
    offset: query.offset,
  });
});

// =============================================================================
// Settings Routes
// =============================================================================

/**
 * GET /admin/settings
 * Get all system settings
 */
adminRouter.get("/settings", async (c) => {
  const { getAllSettings } = await import("../models/system-settings");
  const settings = await getAllSettings();
  return c.json({ settings });
});

/**
 * GET /admin/settings/signup
 * Get signup enabled status
 */
adminRouter.get("/settings/signup", async (c) => {
  const { isSignupEnabled } = await import("../models/system-settings");
  const enabled = await isSignupEnabled();
  return c.json({ enabled });
});

/**
 * POST /admin/settings/signup/enable
 * Enable public signup
 */
adminRouter.post("/settings/signup/enable", async (c) => {
  const adminUser = c.get("user");
  const ctx = getRequestContext(c);
  
  const { enableSignup } = await import("../models/system-settings");
  const { logSettingsUpdate } = await import("../models/admin-audit-log");
  
  await enableSignup(adminUser.id);
  
  // Log the action
  await logSettingsUpdate(
    adminUser.id,
    "signup_enabled",
    "true",
    ctx.ipAddress,
    ctx.userAgent
  );
  
  log.info("Signup enabled by admin", { adminUserId: adminUser.id });
  
  return c.json({ 
    success: true, 
    message: "Public signup enabled",
    enabled: true,
  });
});

/**
 * POST /admin/settings/signup/disable
 * Disable public signup
 */
adminRouter.post("/settings/signup/disable", async (c) => {
  const adminUser = c.get("user");
  const ctx = getRequestContext(c);
  
  const { disableSignup } = await import("../models/system-settings");
  const { logSettingsUpdate } = await import("../models/admin-audit-log");
  
  await disableSignup(adminUser.id);
  
  // Log the action
  await logSettingsUpdate(
    adminUser.id,
    "signup_enabled",
    "false",
    ctx.ipAddress,
    ctx.userAgent
  );
  
  log.info("Signup disabled by admin", { adminUserId: adminUser.id });
  
  return c.json({ 
    success: true, 
    message: "Public signup disabled",
    enabled: false,
  });
});

// =============================================================================
// User Creation Routes
// =============================================================================

const createUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  name: z.string().min(1, "Name is required").max(100),
  role: z.enum(["user", "admin"]).optional().default("user"),
});

/**
 * POST /admin/users
 * Create a new user (bypasses signup restrictions)
 */
adminRouter.post("/users", zValidator("json", createUserSchema), async (c) => {
  const adminUser = c.get("user");
  const ctx = getRequestContext(c);
  const { email, password, name, role } = c.req.valid("json");
  
  // Check if user with this email already exists
  const { getUserByEmail } = await import("../models/admin-users");
  const existingUser = await getUserByEmail(email);
  
  if (existingUser) {
    return c.json({ error: "User with this email already exists" }, 400);
  }
  
  // Create the user using Better Auth's internal methods
  // We need to hash the password and insert directly
  const { db } = await import("../db/drizzle");
  const { user: userTable } = await import("../db/schema");
  const { logUserCreate } = await import("../models/admin-audit-log");
  
  // Hash password using Better Auth's method
  const { hashPassword } = await import("better-auth/crypto");
  
  try {
    // Use Better Auth's context to create user with proper password hashing
    const newUserId = crypto.randomUUID();
    
    // Hash password using Better Auth's hashPassword function
    const hashedPassword = await hashPassword(password);
    
    // Insert user directly
    await db.insert(userTable).values({
      id: newUserId,
      email,
      name,
      emailVerified: true, // Admin-created users are pre-verified
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    
    // Insert password into account table (Better Auth stores passwords in accounts table)
    const { account: accountTable } = await import("../db/schema/auth");
    await db.insert(accountTable).values({
      id: crypto.randomUUID(),
      userId: newUserId,
      accountId: newUserId,
      providerId: "credential",
      password: hashedPassword,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    
    // Log the action
    await logUserCreate(
      adminUser.id,
      newUserId,
      email,
      role,
      ctx.ipAddress,
      ctx.userAgent
    );
    
    log.info("User created by admin", {
      adminUserId: adminUser.id,
      newUserId,
      email,
      role,
    });
    
    // Get the created user
    const createdUser = await getUserById(newUserId);
    
    return c.json({
      success: true,
      message: "User created successfully",
      user: createdUser,
    }, 201);
    
  } catch (error) {
    log.error("Failed to create user", { error, email });
    return c.json({ error: "Failed to create user" }, 500);
  }
});
