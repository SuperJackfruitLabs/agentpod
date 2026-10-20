import {
  pgTable,
  text,
  jsonb,
  primaryKey,
  foreignKey,
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
    foreignKey({
      columns: [t.externalSource, t.externalRunId],
      foreignColumns: [
        bridgeDispatches.externalSource,
        bridgeDispatches.externalRunId,
      ],
    }).onDelete("restrict"),
  ],
);
export const salaamWorkDecisions = pgTable("salaam_work_decisions", {
  requestId: text("request_id").primaryKey(),
  workRequestId: text("work_request_id")
    .notNull()
    .references(() => salaamWorkOwners.requestId, { onDelete: "restrict" }),
  decision: jsonb("decision").notNull(),
  producerReceipt: jsonb("producer_receipt"),
  answer: jsonb("answer"),
  daemonReceipt: jsonb("daemon_receipt"),
});
