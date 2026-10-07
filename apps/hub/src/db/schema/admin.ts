/**
 * Admin Schema
 *
 * Tables for admin functionality:
 * - system_settings: Global system configuration
 * - admin_audit_log: Audit trail for admin actions
 */

import {
  pgTable,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// System Settings Table
// =============================================================================

/**
 * System Settings
 * 
 * Global configuration for the system.
 * Uses a key-value pattern for flexibility.
 */
export const systemSettings = pgTable(
  "system_settings",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    description: text("description"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by"),
  }
);

export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;

// =============================================================================
// Admin Audit Log Table
// =============================================================================

/**
 * Admin Audit Log
 * 
 * Records all admin actions for accountability and debugging.
 * Immutable log - entries are never deleted or modified.
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    
    // Who performed the action
    adminUserId: text("admin_user_id")
      .notNull(),
    
    // What action was performed
    action: text("action").notNull(),
    
    // Who/what was affected
    targetUserId: text("target_user_id"),
    targetResourceId: text("target_resource_id"),
    targetResourceType: text("target_resource_type"),
    
    // Action-specific details (JSON)
    details: text("details"),
    
    // Request context
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    
    // Timestamp
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("admin_audit_log_admin_user_id_idx").on(table.adminUserId),
    index("admin_audit_log_target_user_id_idx").on(table.targetUserId),
    index("admin_audit_log_action_idx").on(table.action),
    index("admin_audit_log_created_at_idx").on(table.createdAt),
  ]
);

// =============================================================================
// Type Exports
// =============================================================================

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type InsertAdminAuditLog = typeof adminAuditLog.$inferInsert;

/**
 * Admin action types for audit logging
 */
export type AdminAction =
  | "user_ban"
  | "user_unban"
  | "user_role_change"
  | "user_create"
  | "settings_update"
  | "node_telemetry_update"
  | "node_remove";
