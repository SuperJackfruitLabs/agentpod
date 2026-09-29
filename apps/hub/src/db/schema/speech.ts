/**
 * Per-station text-to-speech settings: an agent's spoken replies.
 *
 * A table of its own, like `station_transcription` and for the same reason:
 * the stations route returns its row wholesale, and an API key — even
 * encrypted — has no business in every station payload the console fetches.
 *
 * No row means inherit everything: the hub-wide setting (`system_settings`
 * key `speech`), or the SPEECH_* environment beneath that, and a voice
 * assigned from the station's id. `voice` and `speak_mode` override on their
 * own, with `mode` left at `inherit`, so an owner can pick a voice without
 * naming a service. Custom fields survive a switch to `off` or `inherit`.
 */

import { pgTable, text, timestamp, foreignKey } from "drizzle-orm/pg-core";
import { stations } from "./stations";
import { user } from "./auth";
import { tenants } from "./tenants";

export const stationSpeech = pgTable("station_speech", {
  stationId: text("station_id")
    .primaryKey()
    .references(() => stations.id, { onDelete: "cascade" }),
  /** The station's tenant, copied from its row on every write. */
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  /** The service: `inherit` | `off` | `custom`. */
  mode: text("mode").notNull().default("inherit"),
  /** A voice id or blend (`af_heart:60+af_bella:40`); null = the hub default, else assigned. */
  voice: text("voice"),
  /** `off` | `voice_in` | `always`; null = the hub's. */
  speakMode: text("speak_mode"),
  url: text("url"),
  /** AES-256-GCM (`utils/encryption.ts`). Never returned to a client. */
  apiKeyEncrypted: text("api_key_encrypted"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
}, (t) => [
  // The tenant is the station's, copied — held honest by a composite FK onto
  // `stations_id_tenant_idx`, as `station_transcription` is.
  foreignKey({
    columns: [t.stationId, t.tenantId],
    foreignColumns: [stations.id, stations.tenantId],
    name: "station_speech_station_tenant_fk",
  }).onDelete("cascade"),
]);

export type StationSpeechRow = typeof stationSpeech.$inferSelect;
