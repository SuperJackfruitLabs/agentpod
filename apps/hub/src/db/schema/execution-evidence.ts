import { pgTable, text, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
export const executionExports = pgTable("execution_exports", {
  requestId: text("request_id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  principalId: text("principal_id").notNull(),
  manifest: jsonb("manifest").notNull(),
  bundle: jsonb("bundle"),
  digest: text("digest").notNull(),
  status: text("status").notNull(),
  uploadId: text("upload_id"),
  receipt: jsonb("receipt"),
});
