/**
 * Admin Audit Log Model
 * 
 * Records all admin actions for accountability and debugging.
 * Provides functions to log and query admin actions.
 */

import { db } from "../db/drizzle";
import { 
  adminAuditLog,
  type AdminAction,
} from "../db/schema/admin";
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { createLogger } from "../utils/logger";

const log = createLogger("admin-audit-log");

// =============================================================================
// Types
// =============================================================================

export interface AdminAuditLogEntry {
  id: string;
  adminUserId: string;
  adminEmail?: string;
  adminName?: string;
  action: AdminAction;
  targetUserId: string | null;
  targetEmail?: string;
  targetName?: string;
  targetResourceId: string | null;
  targetResourceType: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface LogAdminActionInput {
  adminUserId: string;
  action: AdminAction;
  targetUserId?: string;
  targetResourceId?: string;
  targetResourceType?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditLogQueryOptions {
  adminUserId?: string;
  targetUserId?: string;
  action?: AdminAction;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// =============================================================================
// Helpers
// =============================================================================

function parseDetails(details: string | null): Record<string, unknown> | null {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

// =============================================================================
// Logging Functions
// =============================================================================

/**
 * Log an admin action
 */
export async function logAdminAction(input: LogAdminActionInput): Promise<string> {
  const id = crypto.randomUUID();

  await db.insert(adminAuditLog).values({
    id,
    adminUserId: input.adminUserId,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    targetResourceId: input.targetResourceId ?? null,
    targetResourceType: input.targetResourceType ?? null,
    details: input.details ? JSON.stringify(input.details) : null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  log.info("Admin action logged", {
    id,
    action: input.action,
    adminUserId: input.adminUserId,
    targetUserId: input.targetUserId,
  });

  return id;
}

/**
 * Helper to log settings update
 */
export async function logSettingsUpdate(
  adminUserId: string,
  settingKey: string,
  newValue: string,
  ipAddress?: string,
  userAgent?: string
): Promise<string> {
  return logAdminAction({
    adminUserId,
    action: "settings_update",
    targetResourceId: settingKey,
    targetResourceType: "setting",
    details: { settingKey, newValue },
    ipAddress,
    userAgent,
  });
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get audit log entries with filters
 */
export async function getAuditLogs(
  options: AuditLogQueryOptions = {}
): Promise<{ entries: AdminAuditLogEntry[]; total: number }> {
  const {
    adminUserId,
    targetUserId,
    action,
    startDate,
    endDate,
    limit = 50,
    offset = 0,
  } = options;

  // Build conditions
  const conditions = [];
  
  if (adminUserId) {
    conditions.push(eq(adminAuditLog.adminUserId, adminUserId));
  }
  if (targetUserId) {
    conditions.push(eq(adminAuditLog.targetUserId, targetUserId));
  }
  if (action) {
    conditions.push(eq(adminAuditLog.action, action));
  }
  if (startDate) {
    conditions.push(gte(adminAuditLog.createdAt, startDate));
  }
  if (endDate) {
    conditions.push(lte(adminAuditLog.createdAt, endDate));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get total count
  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(adminAuditLog)
    .where(whereClause);

  const total = countResult?.count ?? 0;

  // Get entries
  const rows = await db
    .select({
      id: adminAuditLog.id,
      adminUserId: adminAuditLog.adminUserId,
      action: adminAuditLog.action,
      targetUserId: adminAuditLog.targetUserId,
      targetResourceId: adminAuditLog.targetResourceId,
      targetResourceType: adminAuditLog.targetResourceType,
      details: adminAuditLog.details,
      ipAddress: adminAuditLog.ipAddress,
      userAgent: adminAuditLog.userAgent,
      createdAt: adminAuditLog.createdAt,
    })
    .from(adminAuditLog)
    .where(whereClause)
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit)
    .offset(offset);

  // No names or emails: people's accounts live at the org plane, and the hub's `user` table that
  // used to fill these in was dropped (P3 plan, Task 17). The ids are `prn_`s.
  const entries: AdminAuditLogEntry[] = rows.map(row => ({
    id: row.id,
    adminUserId: row.adminUserId,
    action: row.action as AdminAction,
    targetUserId: row.targetUserId,
    targetResourceId: row.targetResourceId,
    targetResourceType: row.targetResourceType,
    details: parseDetails(row.details),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  }));

  return { entries, total };
}

/**
 * Get audit log entries for a specific user (as target)
 */
export async function getAuditLogsForUser(
  targetUserId: string,
  limit = 50,
  offset = 0
): Promise<{ entries: AdminAuditLogEntry[]; total: number }> {
  return getAuditLogs({ targetUserId, limit, offset });
}

/**
 * Get audit log entries by a specific admin
 */
export async function getAuditLogsByAdmin(
  adminUserId: string,
  limit = 50,
  offset = 0
): Promise<{ entries: AdminAuditLogEntry[]; total: number }> {
  return getAuditLogs({ adminUserId, limit, offset });
}

/**
 * Get recent audit log entries
 */
export async function getRecentAuditLogs(
  limit = 20
): Promise<AdminAuditLogEntry[]> {
  const result = await getAuditLogs({ limit });
  return result.entries;
}
