/**
 * Admin Users Model
 * 
 * Admin operations for user management including:
 * - List/search users
 * - Get user details
 * - Ban/unban users
 * - Update user roles
 */

import { db } from "../db/drizzle";
import { user, session, type User, type UserRole } from "../db/schema/auth";
import { hubOperators } from "../db/schema/operators";
import { orgPlane } from "../auth/org-plane/config";
import { eq, sql, like, or, and, count } from "drizzle-orm";
import { createLogger } from "../utils/logger";

const log = createLogger("admin-users");

// =============================================================================
// Types
// =============================================================================

export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  role: UserRole;
  // Ban status
  banned: boolean;
  bannedReason: string | null;
  bannedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Stats
  sandboxCount: number;
  runningSandboxCount: number;
}

export interface ListUsersOptions {
  search?: string;
  role?: UserRole;
  banned?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: "email" | "name" | "createdAt" | "role";
  sortDirection?: "asc" | "desc";
}

export interface AdminStats {
  totalUsers: number;
  adminUsers: number;
  bannedUsers: number;
  totalSandboxes: number;
  runningSandboxes: number;
  usersThisWeek: number;
}

// =============================================================================
// List/Search Users
// =============================================================================

/**
 * List users with pagination and filters
 */
export async function listUsers(
  options: ListUsersOptions = {}
): Promise<{ users: AdminUserView[]; total: number }> {
  const {
    search,
    role,
    banned,
    limit = 25,
    offset = 0,
    sortBy = "createdAt",
    sortDirection = "desc",
  } = options;

  // Build conditions
  const conditions = [];

  if (search) {
    const searchPattern = `%${search}%`;
    conditions.push(
      or(
        like(user.email, searchPattern),
        like(user.name, searchPattern)
      )
    );
  }

  if (role) {
    conditions.push(eq(user.role, role));
  }

  if (banned !== undefined) {
    conditions.push(eq(user.banned, banned));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get total count
  const [countResult] = await db
    .select({ count: count() })
    .from(user)
    .where(whereClause);

  const total = countResult?.count ?? 0;

  // Build order clause
  const orderColumn = {
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    role: user.role,
  }[sortBy];

  const orderFn = sortDirection === "asc" 
    ? sql`${orderColumn} ASC`
    : sql`${orderColumn} DESC`;

  // Get users
  const rows = await db
    .select()
    .from(user)
    .where(whereClause)
    .orderBy(orderFn)
    .limit(limit)
    .offset(offset);

  // Map to AdminUserView
  const users: AdminUserView[] = rows.map(row => ({
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    emailVerified: row.emailVerified,
    role: row.role as UserRole,
    banned: row.banned,
    bannedReason: row.bannedReason,
    bannedAt: row.bannedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sandboxCount: 0,
    runningSandboxCount: 0,
  }));

  return { users, total };
}

// =============================================================================
// Get User Details
// =============================================================================

/**
 * Get detailed user info including limits
 */
export async function getUserById(userId: string): Promise<AdminUserView | null> {
  const [row] = await db
    .select()
    .from(user)
    .where(eq(user.id, userId));

  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    emailVerified: row.emailVerified,
    role: row.role as UserRole,
    banned: row.banned,
    bannedReason: row.bannedReason,
    bannedAt: row.bannedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sandboxCount: 0,
    runningSandboxCount: 0,
  };
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(user)
    .where(eq(user.email, email));

  return row ?? null;
}

// =============================================================================
// Ban/Unban Users
// =============================================================================

/**
 * Ban a user
 * - Sets banned flag and reason
 * - Revokes all sessions
 * - Stops all running containers (caller's responsibility)
 */
export async function banUser(
  userId: string,
  reason: string
): Promise<User | null> {
  const now = new Date();

  const [row] = await db
    .update(user)
    .set({
      banned: true,
      bannedReason: reason,
      bannedAt: now,
      updatedAt: now,
    })
    .where(eq(user.id, userId))
    .returning();

  if (row) {
    // Revoke all sessions
    await db
      .delete(session)
      .where(eq(session.userId, userId));

    log.info("User banned", { userId, reason });
  }

  return row ?? null;
}

/**
 * Unban a user
 */
export async function unbanUser(userId: string): Promise<User | null> {
  const [row] = await db
    .update(user)
    .set({
      banned: false,
      bannedReason: null,
      bannedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(user.id, userId))
    .returning();

  if (row) {
    log.info("User unbanned", { userId });
  }

  return row ?? null;
}

// =============================================================================
// Role Management
// =============================================================================

/**
 * Update user role
 */
export async function updateUserRole(
  userId: string,
  newRole: UserRole
): Promise<{ user: User; oldRole: UserRole } | null> {
  // Get current role
  const [current] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId));

  if (!current) return null;

  const oldRole = current.role as UserRole;

  // Update role
  const [row] = await db
    .update(user)
    .set({
      role: newRole,
      updatedAt: new Date(),
    })
    .where(eq(user.id, userId))
    .returning();

  if (row) {
    log.info("User role updated", { userId, oldRole, newRole });
    return { user: row, oldRole };
  }

  return null;
}

// =============================================================================
// Admin Statistics
// =============================================================================

/**
 * Get system-wide admin statistics
 */
export async function getAdminStats(): Promise<AdminStats> {
  // Total users
  const [totalUsersResult] = await db
    .select({ count: count() })
    .from(user);

  // Admin users
  const [adminUsersResult] = await db
    .select({ count: count() })
    .from(user)
    .where(eq(user.role, "admin"));

  // Banned users
  const [bannedUsersResult] = await db
    .select({ count: count() })
    .from(user)
    .where(eq(user.banned, true));

  // Users this week
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  
  const [usersThisWeekResult] = await db
    .select({ count: count() })
    .from(user)
    .where(sql`${user.createdAt} >= ${oneWeekAgo.toISOString()}`);

  return {
    totalUsers: totalUsersResult?.count ?? 0,
    adminUsers: adminUsersResult?.count ?? 0,
    bannedUsers: bannedUsersResult?.count ?? 0,
    totalSandboxes: 0,
    runningSandboxes: 0,
    usersThisWeek: usersThisWeekResult?.count ?? 0,
  };
}

/**
 * Check if user is admin
 */
export async function isUserAdmin(userId: string): Promise<boolean> {
  if (orgPlane()) {
    // Under the plane the caller's id is their prn_ and the token carries no role: admin is a seat
    // in hub_operators (decision D4). `user.role` is not consulted; it is the legacy answer only.
    const [seat] = await db
      .select({ id: hubOperators.principalId })
      .from(hubOperators)
      .where(eq(hubOperators.principalId, userId))
      .limit(1);
    return !!seat;
  }
  const [row] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId));

  return row?.role === "admin";
}

/**
 * Check if user is banned
 */
export async function isUserBanned(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ banned: user.banned })
    .from(user)
    .where(eq(user.id, userId));

  return row?.banned ?? false;
}

/**
 * Get user's role
 */
export async function getUserRole(userId: string): Promise<UserRole | null> {
  const [row] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId));

  return (row?.role as UserRole) ?? null;
}
