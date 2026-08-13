import { pgTable, text, timestamp, index, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { tenants } from "./tenants";

export const agentTaskStatusEnum = pgEnum("agent_task_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const sandboxProviderEnum = pgEnum("sandbox_provider", [
  "docker",
  "cloudflare",
]);

export const cloudflareSandboxStatusEnum = pgEnum("cloudflare_sandbox_status", [
  "creating",
  "running",
  "sleeping",
  "stopped",
  "error",
]);

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id").notNull(),
    provider: sandboxProviderEnum("provider").notNull().default("cloudflare"),
    status: agentTaskStatusEnum("status").notNull().default("pending"),
    message: text("message").notNull(),
    response: text("response"),
    gitUrl: text("git_url"),
    modelProvider: text("model_provider"),
    modelId: text("model_id"),
    sessionId: text("session_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    error: text("error"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("agent_tasks_user_id_idx").on(table.userId),
    index("agent_tasks_status_idx").on(table.status),
    index("agent_tasks_sandbox_id_idx").on(table.sandboxId),
    index("agent_tasks_created_at_idx").on(table.createdAt),
    index("agent_tasks_tenant_id_idx").on(table.tenantId),
  ]
);

export const cloudflareSandboxes = pgTable(
  "cloudflare_sandboxes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: cloudflareSandboxStatusEnum("status").notNull().default("sleeping"),
    workerUrl: text("worker_url").notNull(),
    configHash: text("config_hash"),
    workspaceSyncedAt: timestamp("workspace_synced_at"),
    lastActiveAt: timestamp("last_active_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("cloudflare_sandboxes_user_id_idx").on(table.userId),
    index("cloudflare_sandboxes_status_idx").on(table.status),
    index("cloudflare_sandboxes_tenant_id_idx").on(table.tenantId),
  ]
);

export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;
export type CloudflareSandbox = typeof cloudflareSandboxes.$inferSelect;
export type NewCloudflareSandbox = typeof cloudflareSandboxes.$inferInsert;
