/**
 * ACP Session Schema
 *
 * Persists ACP (Agent Client Protocol) sessions and their event log so a
 * session's history survives node/hub restarts and can be reconciled
 * against the node-side acp_* session id via nodeSessionId.
 *
 * ACP Slice 2 (hub sessions).
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  index,
  check,
} from "drizzle-orm/pg-core";

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
 *
 * **The id space is `attempt_`, not `run_`.** `run_` is kaambaan's, for the work
 * run it mints and dispatches; this row is one prompt-turn spent executing one
 * of those, and a claimed card takes as many prompt-turns as the work takes, so
 * the two never counted 1:1. This file used to declare `"run_" +
 * uuid-ish` six lines above the comment "We never mint a rival id" — it minted
 * one in the same breath, and the two ids were indistinguishable strings. The
 * CHECK constraints below are what enforces the split now, because the comment
 * demonstrably did not.
 */
export const acpRuns = pgTable("acp_runs", {
  id: text("id").primaryKey(),                                        // "attempt_" + uuid (AcpRunId)
  sessionId: text("session_id").notNull().references(() => acpSessions.id, { onDelete: "cascade" }),
  stationId: text("station_id").notNull(),

  // kaambaan's runId when this attempt came from a claim; null when it did not.
  // We never mint a rival id — and since the two id spaces are now disjoint,
  // that is checked rather than asserted. See packages/contract/src/run.ts.
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

  // Our own key is ours. A `run_…` here would be an orchestrator's work run
  // standing in as this hub's primary key — the collision this table was born
  // with. Prefix-only, deliberately: the suffix family may change, the id space
  // may not.
  check("acp_runs_id_is_agentpod_attempt", sql`${t.id} LIKE 'attempt\\_%'`),
  // The mirror: an external id may be any shape an orchestrator mints (§7 keeps
  // externalSource open), but it may never be one of ours.
  check(
    "acp_runs_external_is_not_agentpod",
    sql`${t.externalRunId} IS NULL OR ${t.externalRunId} NOT LIKE 'attempt\\_%'`,
  ),
  // One fact, two columns: an external run id with no source cannot be joined
  // back to the board that minted it, and a source with no id names an origin
  // nothing points at. Enforced in the contract too (#307) — here as well
  // because a writer can bypass the contract but not the table.
  check(
    "acp_runs_external_pair",
    sql`(${t.externalRunId} IS NULL) = (${t.externalSource} IS NULL)`,
  ),
]);
