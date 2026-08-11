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
  title: text("title"),                                               // first prompt, truncated; null until the first prompt
  lastSeq: integer("last_seq").notNull().default(0),                  // highest event seq persisted for this session
  createdAt: timestamp("created_at").notNull(),
  lastEventAt: timestamp("last_event_at").notNull(),
}, (t) => [
  index("acp_sessions_station_id_idx").on(t.stationId),
  // Ordering index for the paginated per-station history list (newest first).
  index("acp_sessions_station_activity_idx").on(t.stationId, t.lastEventAt.desc()),
]);

export const acpEvents = pgTable("acp_events", {
  sessionId: text("session_id").notNull().references(() => acpSessions.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  // Retention shape (Horizon 0 settles the shape; Horizon 3 enforces the policy).
  //
  // This table is authoritative for transcripts, permission decisions and usage,
  // it is the projection source for kaambaan's activity envelope, and §11 calls
  // it a legal record. It only grows. Without an index on created_at, pruning or
  // exporting by age means a full scan of the largest table in the database —
  // so the index is the schema decision that has to land before the data does.
  //
  // The archival boundary is a *session*, not an event: a session is archivable
  // once ended and older than the retention window, and its events go with it.
  // That keeps a transcript whole, which a legal record has to be.
  index("acp_events_created_at_idx").on(t.createdAt),
]);

/**
 * A run — one attempt on a station, and the join key from §3.
 *
 * A run is a prompt-turn: it opens when a prompt is submitted and closes when
 * the agent yields. A permission request does not close it.
 *
 * Not a FK to stations.id, for the same reason acp_sessions is not: destroying a
 * throwaway runtime must not erase the record of what ran on it.
 */
export const acpRuns = pgTable("acp_runs", {
  id: text("id").primaryKey(),                                        // "run_" + uuid-ish
  sessionId: text("session_id").notNull().references(() => acpSessions.id, { onDelete: "cascade" }),
  stationId: text("station_id").notNull(),

  // kaambaan's runId when this attempt came from a claim; null when it did not.
  // We never mint a rival id — see packages/contract/src/run.ts.
  externalRunId: text("external_run_id"),
  externalSource: text("external_source"),                            // "kaambaan", or another orchestrator

  state: text("state").notNull(),                                     // A2A vocabulary, verbatim

  startSeq: integer("start_seq").notNull(),                           // acp_events.seq that opened the run
  endSeq: integer("end_seq"),                                         // null while live
  startedAt: timestamp("started_at").notNull(),
  endedAt: timestamp("ended_at"),
}, (t) => [
  index("acp_runs_session_idx").on(t.sessionId),
  index("acp_runs_station_started_idx").on(t.stationId, t.startedAt.desc()),
  // The join from the board's side: given kaambaan's runId, find what ran.
  index("acp_runs_external_idx").on(t.externalRunId),
]);
