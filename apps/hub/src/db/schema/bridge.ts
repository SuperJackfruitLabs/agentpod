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
 * and a second id space for a thing kaambaan already names is the failure the
 * `run_`/`attempt_` split exists to prevent.
 */

import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, jsonb, primaryKey, index, check } from "drizzle-orm/pg-core";

import { acpRuns } from "./acp";
import { tenants } from "./tenants";

/** What the bridge knows about a dispatched run, in the order it learns it. */
export const DISPATCH_OUTCOMES = ["working", "produced", "reported", "abandoned"] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const bridgeDispatches = pgTable(
  "bridge_dispatches",
  {
    /** The orchestrator that minted `external_run_id` — "kaambaan" today. */
    externalSource: text("external_source").notNull(),
    /** kaambaan's work run id. Never one of ours; the CHECK below says so. */
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
      sql`${t.outcome} IN ('working', 'produced', 'reported', 'abandoned')`,
    ),
  ],
);
