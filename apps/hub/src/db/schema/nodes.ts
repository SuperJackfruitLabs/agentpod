import { pgTable, text, integer, timestamp, index, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const nodeStatusEnum = pgEnum("node_status", ["online", "offline"]);

export const nodes = pgTable("nodes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hostname: text("hostname").notNull(),
  os: text("os").notNull(),
  arch: text("arch").notNull(),
  cpuCount: integer("cpu_count").notNull().default(0),
  secretHash: text("secret_hash").notNull(),
  agentVersion: text("agent_version"),
  // Node-level capabilities from the hello frame. Null on nodes that predate
  // them — "did not say" stays distinguishable from "said nothing".
  capabilities: jsonb("capabilities").$type<string[]>(),
  status: nodeStatusEnum("status").notNull().default("offline"),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [index("nodes_user_id_idx").on(t.userId)]);

export const runtimeStatusEnum = pgEnum("runtime_status", ["provisioning", "starting", "online", "stopping", "stopped", "asleep", "error", "destroyed"]);

export const provisionedRuntimes = pgTable("provisioned_runtimes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  externalId: text("external_id"),
  status: runtimeStatusEnum("status").notNull().default("provisioning"),
  // Why the runtime is in its current status, when the status alone doesn't
  // say — e.g. "no node enrolled within 2m of the start request". Null when
  // there is nothing to explain.
  statusReason: text("status_reason"),
  nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  resourceTier: text("resource_tier").notNull().default("small"),
  harness: text("harness").notNull().default("none"),
  // Container runtime the provider reported, e.g. "runsc". Null when the
  // provider has no such concept, or the row predates the field.
  runtime: text("runtime"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [index("provisioned_runtimes_user_id_idx").on(t.userId)]);

export const enrollmentTokens = pgTable("enrollment_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  provisionedRuntimeId: text("provisioned_runtime_id").references(() => provisionedRuntimes.id, { onDelete: "set null" }),
}, (t) => [index("enrollment_tokens_user_id_idx").on(t.userId)]);
