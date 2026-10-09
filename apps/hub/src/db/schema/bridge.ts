/**
 * The bridge's ledger: one row per work run claimed from an orchestrator.
 *
 * **Why this is not more columns on `acp_runs`.** An `acp_runs` row is one
 * prompt-turn on a station — it exists for hand-driven console sessions with no
 * board anywhere, and the shared corpus
 * (`fixtures/ecosystem-identity/run_join_key.json`) pins exactly what its
 * external pair means. What the bridge needs on top of that is bookkeeping
 * about a *claim*: which board and card it came from, which lease epoch it was
 * granted, which configured agent identity holds it, and — the part that earns
 * the table — **whether the work finished without the board ever being told.**
 * None of that belongs on a generic attempt row, and putting it there would
 * make every console session carry columns that are null by construction.
 *
 * **Why the outcome column exists at all.** Reclaim is at-least-once. Spike RQ4
 * watched a harness finish its work at t+180s and the board hand the same card
 * to a second agent at t+900s, because the bridge died before calling
 * `complete` and nothing on the board had learned. That was judged the *likely*
 * production failure — not a race, just silently repeated work. `produced`
 * without `reported` is precisely that state, written down before the report is
 * attempted, so the next claim of the same card can find it.
 *
 * The primary key is `(external_source, external_run_id)` — the orchestrator's
 * own identifier for the work. No id is minted here: AgentPod is the executor,
 * and a second id space for a thing superpipeline already names is the failure the
 * `run_`/`attempt_` split exists to prevent.
 */

import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, jsonb, primaryKey, index, check, boolean, foreignKey } from "drizzle-orm/pg-core";

import { acpRuns } from "./acp";
import { tenants } from "./tenants";
import { stations } from "./stations";

/**
 * What the bridge knows about a dispatched run, in the order it learns it.
 *
 * `released` is its own outcome rather than a flavour of `abandoned` because the
 * two answer different questions for whoever reads the row next. `released`
 * means **no session was ever opened**: the claim was handed straight back to
 * the board, unpenalised, and nothing can have touched the workspace.
 * `abandoned` means the run stopped after it had started — a lost lease, a
 * foreign run, or a harness that died mid-turn — and the workspace may hold
 * partial work. `acp_run_id` cannot carry that distinction on its own: it is
 * written on the first ACP event, so a session that opened and failed before
 * emitting one leaves it null too.
 */
export const DISPATCH_OUTCOMES = ["working", "produced", "reported", "released", "abandoned"] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const bridgeDispatches = pgTable(
  "bridge_dispatches",
  {
    /** The orchestrator that minted `external_run_id` — "superpipeline" today. */
    externalSource: text("external_source").notNull(),
    /** superpipeline's work run id. Never one of ours; the CHECK below says so. */
    externalRunId: text("external_run_id").notNull(),

    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    /** The orchestrator's board and card. Opaque here — not our id space. */
    boardId: text("board_id").notNull(),
    externalCardId: text("external_card_id").notNull(),

    /** Which configured bridge agent identity claimed it. */
    agentKey: text("agent_key").notNull(),
    stationId: text("station_id").notNull(),
    /** The epoch the claim granted. Every verb on this run must echo it. */
    leaseEpoch: integer("lease_epoch").notNull(),

    /**
     * The attempt that executed it. Null between the claim and the session
     * opening, and after the session's row is deleted with its station.
     */
    acpRunId: text("acp_run_id").references(() => acpRuns.id, { onDelete: "set null" }),

    outcome: text("outcome").notNull(),
    /** Why it ended where it did — a lost lease, a foreign run, a harness fault. */
    reason: text("reason"),
    /** The handoff produced by the work, held so a lost report can be replayed. */
    result: jsonb("result"),

    /**
     * **What coalescing actually did on this run**, as two numbers.
     *
     * Coalescing exists because one trivial prompt produced 57 ACP events from
     * Codex and 1,051 from Hermes — an 18x spread that no fixed rate limit
     * fits. But the first real card run through the bridge could be measured
     * only on the way IN: 142 rows in `acp_events`, and no way whatsoever to
     * learn how many activities went out. Coalescing could have been completely
     * broken in production and nothing would have shown it.
     *
     * These live here rather than on `acp_runs` for the same reason the table
     * exists: this is bookkeeping about a *claim*, and a hand-driven console
     * session has no activities to post to anybody. They are two raw counts and
     * not a ratio, because a ratio is `events_received / activities_posted` in
     * whatever query asks — and storing a derived number is how you end up with
     * a row whose parts disagree with its whole.
     *
     * **Nullable on purpose, and `0` is not `NULL`.** Null means *nobody
     * counted*: a row written before this shipped, a claim handed straight back,
     * a replay that started no harness. Zero means *counted, and the transcript
     * projected to nothing* — a real and alarming state that a `NOT NULL
     * DEFAULT 0` would make indistinguishable from every unmeasured row in the
     * table. It also makes the migration safe against live rows by
     * construction, which `ADD COLUMN … NOT NULL` is not.
     */
    eventsReceived: integer("events_received"),
    activitiesPosted: integer("activities_posted"),

    startedAt: timestamp("started_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    // The orchestrator's identifier for the work IS the key. Nothing minted here.
    primaryKey({ columns: [t.externalSource, t.externalRunId] }),

    // The at-least-once lookup: given a card being dispatched again, did an
    // earlier run of it produce output nobody ever reported?
    index("bridge_dispatches_card_idx").on(t.tenantId, t.externalSource, t.boardId, t.externalCardId),
    index("bridge_dispatches_tenant_id_idx").on(t.tenantId),
    index("bridge_dispatches_attempt_idx").on(t.acpRunId),

    // The mirror of acp_runs_external_is_not_agentpod: an `attempt_…` here is
    // AgentPod's own key standing in for a board's work run.
    check("bridge_dispatches_external_is_not_agentpod", sql`${t.externalRunId} NOT LIKE 'attempt\\_%'`),
    check(
      "bridge_dispatches_outcome",
      sql`${t.outcome} IN ('working', 'produced', 'reported', 'released', 'abandoned')`,
    ),
  ],
);

/**
 * The bridge's roster: which agent identities claim from which board, onto which station.
 *
 * **Why this is not an env var any more.** It was `SUPERPIPELINE_BRIDGE_AGENTS`, a JSON array in
 * `hub.env`, which meant every roster change — adding an agent, rotating a token, moving a station
 * — needed root on the hub host and a restart, while every comparable thing in AgentPod (station
 * adoption, git identities, Matrix credentials, plugin operations) is a tenant-scoped row a human
 * creates in the console. It also had no `tenant_id`, so `tenantScope()` discipline stopped at the
 * bridge, and nothing checked a `stationId` against a station that exists: a stale one surfaced
 * only at claim time, as "station not ready", which is what an offline node looks like too.
 *
 * **`hubUserId` is gone, not moved.** `getStation(userId, stationId)` filters on
 * `stations.userId`, so a roster entry naming any other user failed every ACP call as "Station not
 * found". The field could only ever hold one correct value; it is read from the station now.
 *
 * Design: `docs/superpowers/specs/2026-09-29-bridge-roster-in-the-database-design.md`.
 */
export const bridgeAgents = pgTable(
  "bridge_agents",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** Stable name. Lands in `bridge_dispatches.agent_key` and every log line. */
    key: text("key").notNull(),
    /** superpipeline's own `brd_…`. Not a foreign key: the board is theirs, not ours. */
    boardId: text("board_id").notNull(),
    /** The station its work runs on — and, through it, the user its sessions belong to. */
    stationId: text("station_id").notNull(),
    mode: text("mode").notNull().default("full-auto"),
    /** Null means the 30-minute default in `services/bridge/config.ts`. */
    permissionWaitMs: integer("permission_wait_ms"),
    maxConcurrency: integer("max_concurrency"),
    profileKey: text("profile_key"),
    /**
     * This agent's superpipeline credential, AES-256-GCM (`utils/encryption.ts`). Never returned
     * to a client — the read surface answers `hasToken`, not the token.
     */
    tokenEncrypted: text("token_encrypted").notNull(),
    /**
     * The second, `run`-scoped credential the HARNESS spends over MCP, so a dispatched agent can
     * complete or block its own card. Deliberately not `token`: that one can claim, and an agent
     * holding it could take a second card while still working the first.
     */
    mcpTokenEncrypted: text("mcp_token_encrypted"),
    /** Stop an agent without destroying the row, and the credential a human pasted into it. */
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** The reconciler restarts a loop when this moves, which is how an edit takes effect. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.key] }),
    foreignKey({
      columns: [t.stationId, t.tenantId],
      foreignColumns: [stations.id, stations.tenantId],
      name: "bridge_agents_station_tenant_fk",
    }).onDelete("restrict"),
    index("bridge_agents_station_idx").on(t.stationId),
    index("bridge_agents_board_idx").on(t.boardId),
    check("bridge_agents_mode_check", sql`${t.mode} IN ('ask', 'accept-edits', 'full-auto')`),
    check("bridge_agents_wait_check", sql`${t.permissionWaitMs} IS NULL OR ${t.permissionWaitMs} > 0`),
    check("bridge_agents_concurrency_check", sql`${t.maxConcurrency} IS NULL OR ${t.maxConcurrency} > 0`),
    check("bridge_agents_board_grammar_check", sql`${t.boardId} ~ '^brd_[0-9a-f]{16}$'`),
  ],
);

export type BridgeAgentRow = typeof bridgeAgents.$inferSelect;
export type InsertBridgeAgent = typeof bridgeAgents.$inferInsert;

/**
 * Per-board bridge settings, set by an operator. A board with no row has every default.
 *
 * `related_work` switches the card prompt's "Related prior work" section (Superlibrary spec §10):
 * on by default, so a workspace with Superlibrary configured gets it without a step, and off for
 * a board whose cards should be worked without earlier work in view.
 *
 * `board_id` is superpipeline's `brd_…`, not a foreign key: the board is theirs, not ours.
 */
export const bridgeBoardSettings = pgTable(
  "bridge_board_settings",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    boardId: text("board_id").notNull(),
    relatedWork: boolean("related_work").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.boardId] }),
    check("bridge_board_settings_board_grammar_check", sql`${t.boardId} ~ '^brd_[0-9a-f]{16}$'`),
  ],
);
