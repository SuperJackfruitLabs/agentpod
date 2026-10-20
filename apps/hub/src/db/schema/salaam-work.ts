import {
  pgTable,
  text,
  jsonb,
  primaryKey,
  foreignKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { acpSessions } from "./acp";
import { bridgeDispatches } from "./bridge";
export const salaamWorkOwners = pgTable(
  "salaam_work_owners",
  {
    externalSource: text("external_source").notNull(),
    externalRunId: text("external_run_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    sessionId: text("session_id")
      .notNull()
      .unique()
      .references(() => acpSessions.id, { onDelete: "restrict" }),
    requestId: text("request_id").notNull().unique(),
    payload: jsonb("payload").notNull(),
    receipt: jsonb("receipt"),
  },
  (t) => [
    primaryKey({ columns: [t.externalSource, t.externalRunId] }),
    uniqueIndex("salaam_work_owner_request_tenant_idx").on(
      t.requestId,
      t.tenantId,
    ),
    foreignKey({
      columns: [t.sessionId, t.tenantId],
      foreignColumns: [acpSessions.id, acpSessions.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.externalSource, t.externalRunId],
      foreignColumns: [
        bridgeDispatches.externalSource,
        bridgeDispatches.externalRunId,
      ],
    }).onDelete("restrict"),
  ],
);
export const salaamWorkDecisions = pgTable(
  "salaam_work_decisions",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    requestId: text("request_id").primaryKey(),
    workRequestId: text("work_request_id")
      .notNull()
      .references(() => salaamWorkOwners.requestId, { onDelete: "restrict" }),
    decision: jsonb("decision").notNull(),
    producerReceipt: jsonb("producer_receipt"),
    answer: jsonb("answer"),
    daemonReceipt: jsonb("daemon_receipt"),
  },
  (t) => [
    foreignKey({
      columns: [t.workRequestId, t.tenantId],
      foreignColumns: [salaamWorkOwners.requestId, salaamWorkOwners.tenantId],
    }).onDelete("restrict"),
  ],
);
export const salaamWorkReports = pgTable(
  "salaam_work_reports",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    workRequestId: text("work_request_id")
      .primaryKey()
      .references(() => salaamWorkOwners.requestId, { onDelete: "restrict" }),
    requestId: text("request_id").notNull().unique(),
    completion: jsonb("completion").notNull(),
    handoff: jsonb("handoff").notNull(),
    handoffDigest: text("handoff_digest").notNull(),
    state: text("state").notNull(),
    boardReceipt: jsonb("board_receipt"),
  },
  (t) => [
    foreignKey({
      columns: [t.workRequestId, t.tenantId],
      foreignColumns: [salaamWorkOwners.requestId, salaamWorkOwners.tenantId],
    }).onDelete("restrict"),
  ],
);
