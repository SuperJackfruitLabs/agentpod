/**
 * The reconciliation sweep — asking the board which gates never arrived.
 *
 * `charter → decisions/2026-08-30-a-gate-closes-over-chat.md` §5 settles the
 * delivery semantics: "push, made durable, with a reconciliation sweep beneath
 * it". Push is the fast path and it is at-least-once *within a cap* — kaambaan
 * retries five times with backoff and then dead-letters the delivery. A gate
 * that exhausts its attempts is silent on both sides: the card is blocked on an
 * approval, and neither product is looking for one that never rang.
 *
 * That is the same failure the estate keeps finding at other levels — a service
 * failing 116,666 times over eight days with nothing configured to notice. The
 * sweep is what makes "a gate cannot be lost" a property rather than a hope.
 *
 * ## It has to report what it could NOT place
 *
 * This file counted `sent` and nothing else for most of its life, which made it
 * the same failure one level up: a gate that came back `no-room`, `no-agent` or
 * `no-speaker` was seen, stepped over, and reported as nothing — the number an
 * operator reads is identical whether every gate landed or none did. The
 * whole-branch review found precisely that hiding this branch's own Critical
 * (assignment never provisioned, so every gate resolved `no-room`). The
 * detector and the defect were built on the same branch. Outcomes are tallied
 * by status now, and the three that mean a gate is stuck are warned per gate
 * and again as a pass summary.
 *
 * ## It holds no idempotency of its own
 *
 * `projectGate` claims the gate in `matrix_gate_events` before it sends, so
 * re-offering one already in a room costs a refused insert and posts nothing.
 * Push, redelivery and this are meant to overlap; a second "have I sent this?"
 * check here would be a second answer to a question that already has one, and
 * two answers eventually disagree.
 *
 * ## Every failure is per-board and per-gate
 *
 * A sweep that throws on the first unreachable board stops being a floor, and
 * does it invisibly — the boards behind it are simply never asked. So a board
 * that cannot be reached is recorded and stepped over, and so is a gate whose
 * room refuses the post.
 */

import { KaambaanClient, fetchAdapter, type Fetcher } from "../bridge/kaambaan";
import { isBridgeEnabled, loadBridgeConfig, type BridgeConfig } from "../bridge/config";
import { createLogger } from "../../utils/logger";
import { isGatePending } from "./gates";
import type { GatePendingDelivery, ProjectionOutcome } from "./gates";

const log = createLogger("gate-sweep");

export interface GateSweepDeps {
  /** The kaambaan boards this hub works, from the bridge's own configuration. */
  boards(): Promise<string[]>;
  /**
   * Which fleet a board's gates belong to, or null when this hub never worked
   * it — in which case no card on it was ever dispatched to a station, so no
   * gate on it can have a room.
   */
  tenantIdFor(boardId: string): Promise<string | null>;
  /** Gates the board is still waiting on, read with the bridge's own token. */
  pendingGates(boardId: string): Promise<GatePendingDelivery[]>;
  /** Post the gate, exactly once. Idempotent on `gate_id`. */
  project(tenantId: string, d: GatePendingDelivery): Promise<ProjectionOutcome>;
}

/** Every way `projectGate` can end. Derived, so a new outcome cannot be forgotten here. */
export type GateOutcomeStatus = ProjectionOutcome["status"];

/**
 * The outcomes a gate can land in that mean it is STUCK — a person is waiting
 * on an approval that is not in any room, and nothing else is looking.
 *
 * `sent` is a delivery. `already` is a delivery somebody else made, which is
 * the ordinary healthy answer on a sweep pass and would be pure noise if it
 * warned. These three are the ones that were invisible.
 */
const STUCK: readonly GateOutcomeStatus[] = ["no-room", "no-agent", "no-speaker"];

export interface GateSweepResult {
  /** Pending gates seen across every board that answered. */
  checked: number;
  /** Gates this pass actually put in a room. Anything else was already there,
   *  had nowhere to go, or failed — and none of those is a delivery. */
  projected: number;
  /**
   * Every outcome this pass produced, by status.
   *
   * **The whole-branch review's last finding, and it is this branch's own
   * doing.** `projected` counted `sent` alone, so `no-room`, `no-agent` and
   * `no-speaker` were seen, stepped over, and reported as nothing at all — a
   * sweep whose number reads the same whether every gate landed or none did.
   * That is exactly how the Critical this wave closed stayed invisible:
   * assignment never provisioned, `roomForStation` answered null, every gate
   * came back `no-room`, and the detector built to be the floor beneath push
   * had no way to say so. The detector and the defect shipped on the same
   * branch. Counting by status is what makes "a gate cannot be lost" a
   * property the sweep can actually report on rather than one it merely
   * intends.
   */
  byStatus: Record<GateOutcomeStatus, number>;
  /** Boards that could not be asked. Named, because an empty sweep and an
   *  unreachable board look identical from the outside. */
  failedBoards: string[];
}

/** One sweep pass. Deps are injected so this runs with no network and no db. */
export async function sweepGates(deps: GateSweepDeps): Promise<GateSweepResult> {
  let checked = 0;
  let projected = 0;
  const byStatus: Record<GateOutcomeStatus, number> = {
    sent: 0,
    already: 0,
    "no-room": 0,
    "no-agent": 0,
    "no-speaker": 0,
  };
  const failedBoards: string[] = [];

  for (const boardId of await deps.boards()) {
    const tenantId = await deps.tenantIdFor(boardId);
    if (!tenantId) continue;

    let gates: GatePendingDelivery[];
    try {
      gates = await deps.pendingGates(boardId);
    } catch (err) {
      failedBoards.push(boardId);
      log.warn("could not ask a board for its pending gates", {
        boardId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const gate of gates) {
      if (!isGatePending(gate)) {
        // Loud, because this is the two repositories' contract having drifted
        // — the thing `fixtures/ecosystem-identity/matrix_gate_events.json`
        // exists to catch before it reaches a room.
        log.error("board described a gate in an unknown shape", { boardId });
        continue;
      }
      checked++;
      try {
        const outcome = await deps.project(tenantId, gate);
        byStatus[outcome.status]++;
        if (outcome.status === "sent") {
          projected++;
          // Deliberately loud. Every line here is a gate that push failed to
          // deliver and a person was never asked about — the sweep working is
          // also the signal that something under it is not.
          log.warn("a gate reached its room only by sweep", {
            gateId: gate.gateId,
            boardId,
            roomId: outcome.roomId,
          });
        } else if (STUCK.includes(outcome.status)) {
          // Louder still, and this is the line that was missing. A gate the
          // sweep could not place is the failure the sweep exists to be the
          // floor beneath — it must reach the log of a RUNNING hub, not wait
          // to be noticed in a review months later. `already` is skipped
          // deliberately: it is a gate that was delivered, and warning on it
          // every five minutes would bury these three.
          //
          // `midMove` is the one distinction that keeps this line honest
          // (spec §6): a station between an authorised identity move and its
          // convergence is WAITING, not broken, and a stuck-gate line that
          // cannot tell the two apart turns every move into an alarm — or,
          // worse, teaches an operator to ignore the alarm that matters.
          log.warn("a pending gate could not be put in a room", {
            gateId: gate.gateId,
            boardId,
            status: outcome.status,
            midMove: "midMove" in outcome ? outcome.midMove === true : false,
          });
        }
      } catch (err) {
        log.warn("could not project a gate", {
          gateId: gate.gateId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const stuck = STUCK.reduce((n, status) => n + byStatus[status], 0);
  if (stuck > 0) {
    // One line an operator can alert on, with the tally beside it — the
    // per-gate warns above say which, this says how bad.
    log.warn("pending gates the sweep could not deliver", { stuck, ...byStatus });
  }

  return { checked, projected, byStatus, failedBoards };
}

/**
 * The board-facing half of the sweep, built from the bridge's own configuration.
 *
 * The boards this hub works and the credential for each are already in
 * `KAAMBAAN_BRIDGE_AGENTS` — the sweep needs no configuration of its own, and
 * giving it any would create a second place for the board list to be wrong.
 *
 * **A board is read with its own board's token.** An agent's `kbn_` credential
 * is scoped to the board it claims on, so using the wrong one is a 401 that
 * arrives as `failedBoards` — a board that "could not be reached" rather than a
 * credential that was refused. Deduplicated because two agents on one board is
 * ordinary and asking the same board twice would recover, and log, every gate
 * twice.
 */
export function bridgeGateSweepDeps(
  config: BridgeConfig,
  rest: Pick<GateSweepDeps, "tenantIdFor" | "project">,
  fetchImpl: Fetcher = fetchAdapter,
): GateSweepDeps {
  const tokenForBoard = new Map<string, string>();
  for (const agent of config.agents) {
    if (!tokenForBoard.has(agent.boardId)) tokenForBoard.set(agent.boardId, agent.token);
  }

  return {
    ...rest,
    boards: async () => [...tokenForBoard.keys()],
    pendingGates: async (boardId) => {
      const token = tokenForBoard.get(boardId);
      if (!token) return [];
      return new KaambaanClient({
        baseUrl: config.baseUrl,
        boardId,
        token,
        fetch: fetchImpl,
      }).pendingGates();
    },
  };
}

/**
 * How often to ask.
 *
 * Push carries a gate in under a second and retries five times with backoff
 * before dead-lettering, so this is not the delivery path and does not need to
 * be quick — it is the answer to "and if all of that failed". Five minutes is
 * one small GET per board, and it bounds how long a gate can be silent to
 * something a person waiting on an approval would not notice as unusual.
 */
export const GATE_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Start the periodic sweep, or return null when this hub works no board.
 *
 * Null rather than a timer over an empty list: most hubs run no bridge at all,
 * and a subsystem that is off should not be constructed — the same rule
 * `startKaambaanBridge` follows. It also means any error logged from in here
 * belongs to something the operator actually turned on.
 */
export function startGateSweeper(
  rest: Pick<GateSweepDeps, "tenantIdFor" | "project">,
  opts: { config?: BridgeConfig | null; intervalMs?: number } = {},
): (() => void) | null {
  const config =
    opts.config !== undefined ? opts.config : isBridgeEnabled() ? loadBridgeConfig() : null;
  if (!config) return null;

  const deps = bridgeGateSweepDeps(config, rest);
  const timer = setInterval(() => {
    void sweepGates(deps).catch((err) =>
      log.error("gate sweep failed", { error: err instanceof Error ? err.message : String(err) }),
    );
  }, opts.intervalMs ?? GATE_SWEEP_INTERVAL_MS);

  log.info("gate sweep started", {
    boards: new Set(config.agents.map((a) => a.boardId)).size,
    intervalMs: opts.intervalMs ?? GATE_SWEEP_INTERVAL_MS,
  });
  return () => clearInterval(timer);
}
