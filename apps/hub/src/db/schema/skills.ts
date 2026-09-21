import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  customType,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SkillInstallPlan, SkillInstallReceipt, SkillPlacementPlan, SkillPlacementReceipt } from "@agentpod/contract";
import { tenants } from "./tenants";
import { user } from "./auth";
import { stations } from "./stations";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
export const skillArtifacts = pgTable(
  "skill_artifacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    archiveSHA256: text("archive_sha256").notNull(),
    harness: text("harness").notNull(),
    profile: text("profile").notNull(),
    size: integer("size").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_artifacts_owner_digest_idx").on(
      t.tenantId,
      t.userId,
      t.archiveSHA256,
    ),
    uniqueIndex("skill_artifacts_owner_id_idx").on(t.id, t.tenantId, t.userId),
    check(
      "skill_artifacts_size_check",
      sql`${t.size}>0 AND ${t.size}<=33554432 AND ${t.size}=octet_length(${t.bytes})`,
    ),
    check(
      "skill_artifacts_digest_check",
      sql`${t.archiveSHA256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const skillOperations = pgTable(
  "skill_operations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    stationId: text("station_id").notNull(),
    nodeId: text("node_id").notNull(),
    stationKey: text("station_key").notNull(),
    harness: text("harness").notNull(),
    profile: text("profile").notNull(),
    kind: text("kind").$type<"managed" | "native">().notNull().default("managed"),
    action: text("action").$type<"install" | "rollback" | "activate" | "deactivate">().notNull(),
    artifactId: text("artifact_id"),
    state: text("state")
      .$type<
        | "requested"
        | "planning"
        | "planned"
        | "applying"
        | "applied"
        | "unknown"
        | "conflict"
      >()
      .notNull()
      .default("requested"),
    plan: jsonb("plan").$type<SkillInstallPlan | SkillPlacementPlan>(),
    receipt: jsonb("receipt").$type<SkillInstallReceipt | SkillPlacementReceipt>(),
    error: text("error"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    downloadUntil: timestamp("download_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("skill_operations_station_idx").on(
      t.tenantId,
      t.userId,
      t.stationId,
      t.createdAt,
    ),
    foreignKey({
      name: "skill_operations_station_owner_fk",
      columns: [t.stationId, t.tenantId, t.userId],
      foreignColumns: [stations.id, stations.tenantId, stations.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "skill_operations_artifact_owner_fk",
      columns: [t.artifactId, t.tenantId, t.userId],
      foreignColumns: [
        skillArtifacts.id,
        skillArtifacts.tenantId,
        skillArtifacts.userId,
      ],
    }),
    check(
      "skill_operations_identity_check",
      sql`${t.id} ~ '^[a-f0-9]{32}$' AND ((${t.kind}='managed' AND ${t.action} IN ('install','rollback')) OR (${t.kind}='native' AND ${t.action} IN ('activate','deactivate','rollback'))) AND ((${t.action}='install')=(${t.artifactId} IS NOT NULL))`,
    ),
    check(
      "skill_operations_state_check",
      sql`${t.state} IN ('requested','planning','planned','applying','applied','unknown','conflict')`,
    ),
    check(
      "skill_operations_metadata_check",
      sql`octet_length(${t.plan}::text)<=4194304 AND octet_length(${t.receipt}::text)<=4194304 AND length(${t.error})<=2048`,
    ),
  ],
);
