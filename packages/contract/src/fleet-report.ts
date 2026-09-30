import { z } from "zod";
import { FLEET_QUESTION_MAX, FLEET_STEP_MAX } from "./fleet-live";

// ─── An agent reporting its own turns to the fleet Live Activity ─────────────
//
// The hub's fleet Live Activity (`fleet-live.ts`) hears about a turn from the
// hub's own ACP → Matrix bridge. An agent that runs its own Matrix client (a
// harness-mode Hermes with the `agentpod-live` plugin) never goes through that
// bridge, so its plugin reports the turn itself: one JSON line per event on
// its node's fleet socket (`~/.agentpod/fleet.sock`), which the node forwards
// to the hub as a `fleet.report` frame over its authenticated connection.
//
// **Trust.** The node vouches only for being the node. The hub accepts a
// report only for a station on that node whose Matrix id is `agent`, and only
// when `reader` is that station's owner — `reader` is checked, never used to
// choose whom to tell.
//
// **No more text than the card shows.** A step title and a question are
// bounded by the card's own bounds (A4), and nothing else a turn said has a
// field here. The same plaintext reaches Apple on the card, by operator
// decision (2026-09-29).

/** A report older than this when the hub reads it is dropped: the card shows now, not history. */
export const FLEET_REPORT_MAX_AGE_MS = 120_000;

const COUNT_MAX = 10_000;
const count = z.number().int().nonnegative().max(COUNT_MAX);
/** A bound in characters (code points), which is what a person sees. */
const chars = (max: number) => z.string().refine((s) => [...s].length <= max, `at most ${max} characters`);
const mxid = z.string().max(255).regex(/^@[^\s:]+:\S+$/);
const roomId = z.string().max(255).regex(/^![^\s:]+:\S+$/);
const eventId = z.string().max(255).regex(/^\$\S+$/);

export const FleetTurnEvent = z.discriminatedUnion("type", [
  /** The agent started working on a message. */
  z.object({ type: z.literal("turn-started") }).strict(),
  /** A tool call started or finished. `completed`/`total` are this turn's tool counts so far. */
  z.object({ type: z.literal("step"), title: chars(FLEET_STEP_MAX), completed: count, total: count }).strict(),
  /**
   * The agent began writing its answer (the card's Writing phase). Only that
   * it began: the answer's text never rides in a report. Sent once each time
   * the turn moves into writing. A hub older than this kind drops the frame.
   */
  z.object({ type: z.literal("writing") }).strict(),
  /**
   * The turn ended. `failedAt` is the 1-based position of the first failed
   * tool; `errored` is a turn that did not end normally.
   */
  z
    .object({
      type: z.literal("turn-finished"),
      total: count,
      failed: count,
      failedAt: count.min(1).optional(),
      errored: z.boolean().optional(),
    })
    .strict(),
  /** The room event that carried the answer of a turn that ran tools (spec A5). */
  z.object({ type: z.literal("answer"), eventId, total: count, failed: count }).strict(),
  /** The agent is waiting for its reader to approve something. `eventId` is the question's room event. */
  z.object({ type: z.literal("decision-asked"), eventId, question: chars(FLEET_QUESTION_MAX) }).strict(),
  /** The question was answered, withdrawn or timed out. */
  z.object({ type: z.literal("decision-cleared") }).strict(),
]);
export type FleetTurnEvent = z.infer<typeof FleetTurnEvent>;

export const FleetTurnReport = z
  .object({
    /** The Matrix id the agent speaks as. */
    agent: mxid,
    roomId,
    /** Whom the plugin streams this turn to. Checked against the station's owner. */
    reader: mxid,
    /** Epoch milliseconds on the plugin's host, for staleness only. */
    at: z.number().int().nonnegative(),
    event: FleetTurnEvent,
  })
  .strict();
export type FleetTurnReport = z.infer<typeof FleetTurnReport>;

/** The node forwards a report unchanged, wrapped in this envelope. */
export const FleetReportMsg = z.object({ type: z.literal("fleet.report"), report: FleetTurnReport });
export type FleetReportMsg = z.infer<typeof FleetReportMsg>;
