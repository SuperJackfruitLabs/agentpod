/**
 * An agent reporting its own turn to the fleet Live Activity.
 *
 * The fleet card hears about a turn from the hub's ACP → Matrix bridge
 * (`matrix-as/outbound.ts`). An agent that runs its own Matrix client — a
 * harness-mode Hermes with the `agentpod-live` plugin, which is every Guild
 * agent — never goes through that bridge, so the hub never heard of its turns
 * and the card never showed them (found on a real phone, 2026-09-29). Its
 * plugin now reports each turn to its node's fleet socket, and the node
 * forwards the report here as a `fleet.report` frame over the connection it
 * already authenticated (`routes/gateway.ts`).
 *
 * What this does with a report:
 *
 * - **Believes it only for the node's own agent, and only for its owner.**
 *   `resolve` finds the station on the AUTHENTICATED node whose Matrix id is
 *   the report's `agent`, and that station's owner's Matrix id. A report that
 *   names another reader is dropped, never redirected: `reader` in the body is
 *   a check, not an address. A node could always act as its own stations'
 *   agents; this gives it nothing beyond that.
 * - **Feeds the same sink the bridge does**, as the same `FleetEvent`s, so the
 *   planner's start/coalesce/end rules are untouched and a bridge agent and a
 *   plugin agent share one reader's card.
 * - **Tags the answer's push with the turn's counts (spec A5).** See
 *   `announceAnswer` for how the two orders are handled.
 *
 * Nothing here can slow an agent: the plugin writes to a local socket and
 * moves on, and the node forwards without waiting. Every failure here is a
 * dropped report, logged, never an error sent back.
 */

import { FLEET_REPORT_MAX_AGE_MS, type FleetTurnReport } from "@agentpod/contract";

import { createLogger } from "../../../utils/logger";
import { beginQuietSend, noteAnswerEvent } from "../hub-events";
import { reportingAgentFor } from "./agent-identity";
import { fleetSink, permissionDecisionKey, type FleetSink } from "./sink";
import type { FleetEvent } from "./state";

const log = createLogger("fleet-agent-reports");

/** Who a report is from, as the hub knows it. */
export interface ReportingAgent {
  /** The station owner's Matrix id — the reader whose card this is. */
  reader: string;
  /** The agent's name on the card: its station's display name. */
  name: string;
}

export type ReportOutcome = "off" | "stale" | "unknown-agent" | "not-owner" | "applied";

/** How long "who is this agent" is remembered — hits and misses alike. */
export const IDENTITY_CACHE_MS = 60_000;
const IDENTITY_CACHE_MAX = 1_000;

/**
 * How long a finished turn's room holds its pushes for the answer's id.
 *
 * The plugin reports the finish before Hermes even sends the answer, and the
 * answer's id within milliseconds of the send returning, so this is only the
 * ceiling for an answer that never comes (a turn whose reply failed to send,
 * or a Hermes whose log line changed). Each held push still waits at most the
 * gateway's `QUIET_WAIT_MS`.
 */
export const ANSWER_ANNOUNCE_MS = 15_000;

export interface AgentReportDeps {
  /**
   * The station on `nodeId` that speaks as `agent`, its owner's Matrix id and
   * its name — or null when there is none, or when `roomId` is known to be
   * another station's room.
   */
  resolve(nodeId: string, agent: string, roomId: string): Promise<ReportingAgent | null>;
  sink?: () => FleetSink | null;
  now?: () => number;
  /** Timer seam: run `fn` in `ms`; returns the cancel. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

function realTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
}

export function createAgentReportRelay(deps: AgentReportDeps) {
  const sinkOf = deps.sink ?? fleetSink;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? realTimer;

  const identities = new Map<string, { value: ReportingAgent | null; until: number }>();
  /** Per node and agent, so one agent's reports apply in the order they came. */
  const chains = new Map<string, Promise<unknown>>();
  /** Rooms whose finished turn's answer has not been reported yet. */
  const announced = new Map<string, () => void>();

  async function identify(nodeId: string, agent: string, roomId: string): Promise<ReportingAgent | null> {
    const key = `${nodeId}\n${agent}\n${roomId}`;
    const t = now();
    const hit = identities.get(key);
    if (hit && hit.until > t) return hit.value;
    let value: ReportingAgent | null;
    try {
      value = await deps.resolve(nodeId, agent, roomId);
    } catch (err) {
      // Not remembered: the next report asks again.
      log.warn("could not look up a reporting agent", {
        nodeId,
        agent,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!value) log.info("a fleet report from an agent this node does not host; dropped", { nodeId, agent, roomId });
    identities.delete(key);
    identities.set(key, { value, until: t + IDENTITY_CACHE_MS });
    while (identities.size > IDENTITY_CACHE_MAX) {
      const oldest = identities.keys().next().value;
      if (oldest === undefined) break;
      identities.delete(oldest);
    }
    return value;
  }

  /**
   * A turn that ran tools finished: its answer is about to be sent, by the
   * agent, not by the hub. Announced like a quiet send (`hub-events.ts`), so a
   * push for an event in this room that is not yet known waits — bounded by
   * the gateway's `QUIET_WAIT_MS` — for the answer's id to be reported.
   *
   * The orders, and what each gets:
   * - finish, answer id, push: the id is known before the push — counts.
   * - finish, push, answer id: the push waits and the id arrives — counts.
   * - finish, push, and no id within the wait: the push goes without counts.
   * - push before the finish report: nothing is announced yet, so the push
   *   goes at once, without counts. The finish is reported at `post_llm_call`,
   *   before Hermes sends the answer at all, so this is the rare order.
   * Never an unbounded hold, and never a guess: counts ride only on the event
   * the agent said was its answer.
   */
  function announceAnswer(roomId: string): void {
    settleAnswer(roomId);
    const end = beginQuietSend(roomId);
    const cancel = setTimer(() => settleAnswer(roomId), ANSWER_ANNOUNCE_MS);
    announced.set(roomId, () => {
      cancel();
      end();
    });
  }

  function settleAnswer(roomId: string): void {
    const done = announced.get(roomId);
    if (!done) return;
    announced.delete(roomId);
    done();
  }

  async function apply(nodeId: string, report: FleetTurnReport): Promise<ReportOutcome> {
    const sink = sinkOf();
    // No APNs, no card and no push gateway: nothing is listening, and an
    // unconfigured hub does no lookups for it.
    if (!sink) return "off";
    const t = now();
    if (Math.abs(t - report.at) > FLEET_REPORT_MAX_AGE_MS) return "stale";

    const who = await identify(nodeId, report.agent, report.roomId);
    if (!who) return "unknown-agent";
    if (who.reader !== report.reader) {
      log.debug("a fleet report for someone other than the station's owner; dropped", {
        nodeId,
        agent: report.agent,
        roomId: report.roomId,
      });
      return "not-owner";
    }

    const { roomId, event } = report;
    const name = who.name;
    // The station's Matrix id — `resolve` matched it to `agent` — keys the card's avatar.
    const mxid = report.agent;
    const note = (e: FleetEvent) => sink.note(who.reader, e);

    switch (event.type) {
      case "turn-started":
        note({ type: "turn-started", roomId, mxid, name, at: t });
        break;
      case "step":
        note({ type: "step", roomId, mxid, name, title: event.title, completed: event.completed, total: event.total, at: t });
        break;
      case "turn-finished":
        note({
          type: "turn-finished",
          roomId,
          mxid,
          name,
          total: event.total,
          failed: event.failed,
          ...(event.failedAt !== undefined ? { failedAt: event.failedAt } : {}),
          ...(event.errored !== undefined ? { errored: event.errored } : {}),
          at: t,
        });
        // Only a turn that ran tools has counts for its answer (as the bridge).
        if (event.total > 0) announceAnswer(roomId);
        break;
      case "answer":
        noteAnswerEvent(event.eventId, { total: event.total, failed: event.failed });
        settleAnswer(roomId);
        break;
      case "decision-asked":
        note({
          type: "decision-asked",
          decision: {
            key: permissionDecisionKey(roomId),
            roomId,
            eventId: event.eventId,
            agent: name,
            kind: "permission",
            question: event.question,
            // Answered in the room (Hermes takes a reaction or `!approve`), not
            // through the hub's permission path, so the card offers no buttons
            // it could not honour. A tap opens the question.
            options: [],
            askedAt: t,
          },
        });
        break;
      case "decision-cleared":
        note({ type: "decision-cleared", key: permissionDecisionKey(roomId) });
        break;
    }
    const level = event.type === "step" ? "debug" : "info";
    log[level]("fleet report applied", { nodeId, agent: report.agent, roomId, event: event.type });
    return "applied";
  }

  return {
    /** Apply one report from `nodeId`. Never rejects. */
    handle(nodeId: string, report: FleetTurnReport): Promise<ReportOutcome> {
      const key = `${nodeId}\n${report.agent}`;
      const prev = chains.get(key) ?? Promise.resolve();
      const run = prev.then(() => apply(nodeId, report)).catch((err): ReportOutcome => {
        log.error("a fleet report failed", { nodeId, error: err instanceof Error ? err.message : String(err) });
        return "unknown-agent";
      });
      chains.set(key, run);
      void run.finally(() => {
        if (chains.get(key) === run) chains.delete(key);
      });
      return run;
    },

    stop(): void {
      for (const roomId of [...announced.keys()]) settleAnswer(roomId);
      identities.clear();
    },
  };
}

export type AgentReportRelay = ReturnType<typeof createAgentReportRelay>;

let relay: AgentReportRelay | null = null;

/**
 * The gateway's entry point: a `fleet.report` frame from an authenticated
 * node. Fire-and-forget; the relay is built on first use, over the database.
 */
export function reportAgentTurn(nodeId: string, report: FleetTurnReport): void {
  if (!fleetSink()) return;
  relay ??= createAgentReportRelay({ resolve: reportingAgentFor });
  void relay.handle(nodeId, report);
}
