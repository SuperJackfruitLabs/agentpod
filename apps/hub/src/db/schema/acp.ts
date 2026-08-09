/**
 * ACP Session Schema
 *
 * Persists ACP (Agent Client Protocol) sessions and their event log so a
 * session's history survives node/hub restarts and can be reconciled
 * against the node-side acp_* session id via nodeSessionId.
 *
 * ACP Slice 2 (hub sessions).
 */

import { pgTable, text, integer, timestamp, jsonb, primaryKey, index } from "drizzle-orm/pg-core";

export const acpSessions = pgTable("acp_sessions", {
  id: text("id").primaryKey(),                                        // "acps_" + uuid-ish
  // Deliberately NOT a FK to stations.id (no ON DELETE CASCADE), mirroring the
  // station_audit.stationKey precedent: transcripts must survive station
  // deletion. Destroying a throwaway runtime/station must not silently erase
  // conversation history. See review finding 2026-08-09 — a cascading FK here
  // would wipe acp_events (via acp_sessions) the moment the station row is
  // removed.
  stationId: text("station_id").notNull(),
  userId: text("user_id").notNull(),
  mode: text("mode").notNull(),                                       // ask | accept-edits | full-auto
  status: text("status").notNull(),                                   // starting|idle|working|waiting|ended
  endedReason: text("ended_reason"),
  nodeSessionId: text("node_session_id"),                             // the node-side acp_* id, for reconciliation acp.close
  createdAt: timestamp("created_at").notNull(),
  lastEventAt: timestamp("last_event_at").notNull(),
}, (t) => [index("acp_sessions_station_id_idx").on(t.stationId)]);

export const acpEvents = pgTable("acp_events", {
  sessionId: text("session_id").notNull().references(() => acpSessions.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.sessionId, t.seq] })]);
