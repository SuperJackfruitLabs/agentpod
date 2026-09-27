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
import type { PluginOperationPlan, PluginOperationReceipt, SkillInstallPlan, SkillInstallReceipt, SkillPlacementPlan, SkillPlacementReceipt } from "@agentpod/contract";
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

/** A verified SJL library release, scoped to the importing tenant and owner. */
export const trustedSkillReleases = pgTable(
  "trusted_skill_releases",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    profile: text("profile").notNull(),
    recordDigest: text("record_digest").notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trusted_skill_releases_owner_digest_idx").on(t.tenantId, t.userId, t.recordDigest),
    uniqueIndex("trusted_skill_releases_owner_version_profile_idx").on(t.tenantId, t.userId, t.version, t.profile),
    uniqueIndex("trusted_skill_releases_owner_id_idx").on(t.id, t.tenantId, t.userId),
    check("trusted_skill_releases_digest_check", sql`${t.recordDigest} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Maps every trusted release pin to an existing immutable artifact blob. */
export const trustedSkillReleaseArtifacts = pgTable(
  "trusted_skill_release_artifacts",
  {
    releaseId: text("release_id").notNull(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    harness: text("harness").notNull(),
    bundleDigest: text("bundle_digest").notNull(),
  },
  (t) => [
    uniqueIndex("trusted_skill_release_artifacts_release_harness_idx").on(t.releaseId, t.tenantId, t.userId, t.harness),
    uniqueIndex("trusted_skill_release_artifacts_artifact_idx").on(t.artifactId, t.tenantId, t.userId),
    foreignKey({ name: "trusted_skill_release_artifacts_release_owner_fk", columns: [t.releaseId, t.tenantId, t.userId], foreignColumns: [trustedSkillReleases.id, trustedSkillReleases.tenantId, trustedSkillReleases.userId] }).onDelete("cascade"),
    // The public artifact delete path refuses catalog-pinned blobs.  Cascading
    // here is solely for tenant/user teardown, where PostgreSQL otherwise has
    // no safe ordering across two children of the same user.
    foreignKey({ name: "trusted_skill_release_artifacts_artifact_owner_fk", columns: [t.artifactId, t.tenantId, t.userId], foreignColumns: [skillArtifacts.id, skillArtifacts.tenantId, skillArtifacts.userId] }).onDelete("cascade"),
    check("trusted_skill_release_artifacts_digest_check", sql`${t.bundleDigest} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** An explicit, immutable rollout audience for one trusted release identity. */
export const skillReleaseCohorts = pgTable("skill_release_cohorts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  releaseId: text("release_id").notNull(),
  recordDigest: text("record_digest").notNull(),
  stationIds: jsonb("station_ids").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("skill_release_cohorts_owner_id_idx").on(t.id, t.tenantId, t.userId),
  foreignKey({ name: "skill_release_cohorts_release_owner_fk", columns: [t.releaseId, t.tenantId, t.userId], foreignColumns: [trustedSkillReleases.id, trustedSkillReleases.tenantId, trustedSkillReleases.userId] }).onDelete("restrict"),
  check("skill_release_cohorts_digest_check", sql`${t.recordDigest} ~ '^[a-f0-9]{64}$'`),
  check("skill_release_cohorts_station_ids_check", sql`jsonb_typeof(${t.stationIds})='array' AND jsonb_array_length(${t.stationIds}) BETWEEN 1 AND 256`),
]);

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
    kind: text("kind").$type<"managed" | "native" | "plugin">().notNull().default("managed"),
    action: text("action").$type<"install" | "rollback" | "activate" | "deactivate" | "enable" | "disable">().notNull(),
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
    plan: jsonb("plan").$type<SkillInstallPlan | SkillPlacementPlan | PluginOperationPlan>(),
    receipt: jsonb("receipt").$type<SkillInstallReceipt | SkillPlacementReceipt | PluginOperationReceipt>(),
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
      sql`${t.id} ~ '^[a-f0-9]{32}$' AND ((${t.kind}='managed' AND ${t.action} IN ('install','rollback')) OR (${t.kind}='native' AND ${t.action} IN ('activate','deactivate','rollback')) OR (${t.kind}='plugin' AND ${t.action} IN ('enable','disable'))) AND ((${t.action}='install')=(${t.artifactId} IS NOT NULL))`,
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
