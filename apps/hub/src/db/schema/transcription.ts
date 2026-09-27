/**
 * Per-station speech-to-text settings for voice notes.
 *
 * A table of its own rather than columns on `stations`, for one reason that
 * matters: the stations route returns the row wholesale (`db.select()`), and
 * an API key — even encrypted — has no business in every station payload the
 * console fetches. Here it is read only by the service that resolves it.
 *
 * No row means `inherit`: the hub-wide setting (`system_settings` key
 * `transcription`), or the TRANSCRIBE_* environment beneath that. The custom
 * fields survive a switch to `off` or `inherit`, so switching back does not
 * mean typing them again.
 */

import { pgTable, text, integer, timestamp, foreignKey } from "drizzle-orm/pg-core";
import { stations } from "./stations";
import { user } from "./auth";
import { tenants } from "./tenants";

export const stationTranscription = pgTable("station_transcription", {
  stationId: text("station_id")
    .primaryKey()
    .references(() => stations.id, { onDelete: "cascade" }),
  /** The station's tenant, copied from its row on every write. */
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  /** `inherit` | `off` | `custom`. */
  mode: text("mode").notNull().default("inherit"),
  url: text("url"),
  model: text("model"),
  /** AES-256-GCM (`utils/encryption.ts`). Never returned to a client. */
  apiKeyEncrypted: text("api_key_encrypted"),
  maxSeconds: integer("max_seconds"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
}, (t) => [
  // The tenant is the station's, copied — held honest by a composite FK onto
  // `stations_id_tenant_idx` (migration 0046), as `matrix_rooms` is.
  foreignKey({
    columns: [t.stationId, t.tenantId],
    foreignColumns: [stations.id, stations.tenantId],
    name: "station_transcription_station_tenant_fk",
  }).onDelete("cascade"),
]);

export type StationTranscriptionRow = typeof stationTranscription.$inferSelect;
