import { pgTable, text, timestamp, index, uniqueIndex, jsonb, foreignKey, AnyPgColumn } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { nodes } from "./nodes";
import { tenants } from "./tenants";

export const stations = pgTable("stations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  harness: text("harness").notNull(),
  stationKey: text("station_key").notNull(),
  kind: text("kind").notNull(),
  parentStationId: text("parent_station_id").references((): AnyPgColumn => stations.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  workspacePath: text("workspace_path"),
  capabilities: jsonb("capabilities").$type<string[]>(),
  matrixId: text("matrix_id"),
  /**
   * The identity the Application Service minted for this station. Distinct from
   * `matrixId`, which is what the harness reports and the node agent owns —
   * nobody on the host can report this one, so nothing on the host can erase it.
   */
  bridgeMatrixId: text("bridge_matrix_id"),
  /**
   * Who answers for this station on Matrix — `bridge` (the Application Service
   * speaks for it) or `harness` (it runs its own Matrix client). Never both.
   */
  matrixIdentityMode: text("matrix_identity_mode").notNull().default("bridge"),
  /**
   * What this station is FOR — `personal`, `work`, an ad-hoc name of the
   * operator's choosing. Not where it runs: a node's name carries its purpose
   * only by accident of how this fleet was built, and coming use cases span
   * harnesses and runtimes.
   *
   * The station's is the one anything reads; `nodes.purpose` is only the
   * default applied at adoption to a station that has none. Null means nobody
   * has said, and an unlabelled station is filed under no Matrix space at all.
   */
  purpose: text("purpose"),
  adoptedAt: timestamp("adopted_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("stations_node_id_station_key_idx").on(t.nodeId, t.stationKey),
  index("stations_node_id_idx").on(t.nodeId),
  index("stations_user_id_idx").on(t.userId),
  index("stations_tenant_id_idx").on(t.tenantId),
  // A station's tenant is not an independent fact — it is its node's, copied.
  // A copied fact drifts, so it is a composite FK rather than a convention: the
  // (node_id, tenant_id) pair must exist in nodes, which makes a station in one
  // tenant on a node in another unrepresentable rather than merely unwritten.
  foreignKey({
    columns: [t.nodeId, t.tenantId],
    foreignColumns: [nodes.id, nodes.tenantId],
    name: "stations_node_tenant_fk",
  }).onDelete("cascade"),
]);
