/**
 * The reconciliation sweep — asking the board which gates never arrived.
 *
 * `charter → decisions/2026-08-30-a-gate-closes-over-chat.md` §5 settles the
 * delivery semantics: "push, made durable, with a reconciliation sweep beneath
 * it". Push is the fast path and it is at-least-once *within a cap* — superpipeline
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

import { SuperpipelineClient, fetchAdapter, type Fetcher } from "../bridge";
import { isBridgeEnabled, loadBridgeConfig, type BridgeConfig } from "../bridge";
import { subscribeBoardsToPush, type SuperpipelineRelay } from "../bridge";
import { createLogger } from "../../utils/logger";
import { isGatePending } from "./gates";
import type { GatePendingDelivery, ProjectionOutcome } from "./gates";
import { isDeliveryPending, type DeliveryPendingDelivery } from "./delivery-wire";
import type { DeliveryProjectionOutcome } from "./delivery-projection";
import { isAttentionPending, type AttentionPendingDelivery } from "./attention-wire";
import type { AttentionProjectionOutcome, WaitKey } from "./attention-projection";
import { relayTokenForBoard, type TenantsForBoard } from "./relay-scope";
import { heldUntilOf } from "./gate-release-wire";

const log = createLogger("gate-sweep");

export interface GateSweepDeps {
  /** The superpipeline boards this hub works, from the bridge's own configuration. */
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

  /**
   * Gates this hub has put in a room and has NOT yet posted an outcome for.
   *
   * The other half of the sweep, and the half that was missing. A gate decided in superpipeline's
   * web UI never reaches `handleGateDecision` — that runs only on a Matrix event, which is to say
   * only on a decision made from supermessage — so nothing marks the receipt posted and the room
   * card goes on offering Approve and Reject for a decision already made, with no expiry.
   *
   * Optional so a caller that only wants the projection half keeps working.
   */
  postedGatesAwaitingOutcome?(boardId: string): Promise<Array<{ gateId: string; cardId: string }>>;
  /** How a gate was decided, or null when that cannot be read. `GET …/gates/:gateId`. */
  decisionFor?(
    boardId: string,
    gateId: string,
  ): Promise<{
    decision: string;
    decidedBy: string | null;
    chosen?: { id: string; label: string } | null;
    /** A held approval's release time, named in the receipt (charter 2026-11-09, an approval may wait). */
    heldUntil?: string | null;
  } | null>;
  /**
   * The board's read of one gate, whatever its status, or null when it cannot be read. What an
   * approval of a quorum gate is checked against (`readBoardGate`): accepted is not resolved.
   */
  readGate?(
    boardId: string,
    gateId: string,
  ): Promise<{
    status: string;
    decision: string | null;
    decidedBy: string | null;
    chosen: { id: string; label: string } | null;
    heldUntil?: string | null;
  } | null>;
  /**
   * The board's read of a card's machine checks, or null when there is no credential for the board.
   * Throws when the board cannot be read. What an escalation of overdue checks lists
   * (`readBoardCardChecks`, charter 2026-11-09, a gate may be decided by checks).
   */
  readChecks?(boardId: string, cardId: string): Promise<{ stageKey: string; status: string; checks: unknown[] } | null>;
  /**
   * Post the outcome receipt and claim it, so two sweeps leave one line. `chosen` names a variant
   * chosen; `heldUntil` the release time of a held approval.
   */
  settleOutcome?(
    gateId: string,
    decision: string,
    decidedBy: string | null,
    chosen?: { id: string; label: string } | null,
    heldUntil?: string | null,
  ): Promise<boolean>;
  /**
   * What a board said it is still waiting on, every pass it answered. The
   * fleet Live Activity clears the gates missing from it — an answer given on
   * the board itself reaches the Lock Screen this way — and shows again the
   * ones a restarted hub forgot (`fleet-gates.ts`). Not called for a board
   * that could not be read: its gates are not therefore closed.
   */
  onBoardPending?(boardId: string, gates: GatePendingDelivery[]): Promise<void>;

  /**
   * The follow-ups manual-delivery approvals still owe, read from `GET …/deliveries/pending` —
   * the floor beneath the `delivery.pending` push, as the rest of this sweep is beneath
   * `gate.pending` (charter: "The decision envelope covers questions and follow-ups" §3).
   * `unknown[]`: each is checked with `isDeliveryPending` before it is carried. Optional, with
   * `projectDelivery`, so a caller that only wants gates keeps working.
   */
  pendingDeliveries?(boardId: string): Promise<unknown[]>;
  /** Post a follow-up, exactly once. Idempotent on `gate_id`. */
  projectDelivery?(tenantId: string, d: DeliveryPendingDelivery): Promise<DeliveryProjectionOutcome>;
  /** Follow-ups this hub posted on a board and has not settled (`outcome_posted_at IS NULL`). */
  postedDeliveriesAwaitingOutcome?(boardId: string): Promise<Array<{ gateId: string }>>;
  /**
   * Settle a follow-up the board no longer owes — link recorded on the web, mode switched,
   * subject expired, card archived — with its receipt, claimed once. True when this call posted it.
   */
  settleDelivery?(gateId: string): Promise<boolean>;

  /**
   * The cards a board says are waiting on a person, read from `GET …/attention/pending` — the
   * floor beneath the `attention.pending` push (charter: "Waiting cards and broker approvals reach
   * chat" §1). `unknown[]`, each checked with `isAttentionPending`. Optional, with
   * `projectAttention`, so a caller that only wants gates keeps working.
   */
  pendingAttention?(boardId: string): Promise<unknown[]>;
  /** Post a waiting card, exactly once per wait. Idempotent on board + card + wait. */
  projectAttention?(tenantId: string, d: AttentionPendingDelivery): Promise<AttentionProjectionOutcome>;
  /** Waiting cards this hub posted on a board and has not settled (`outcome_posted_at IS NULL`). */
  postedAttentionAwaitingOutcome?(boardId: string): Promise<WaitKey[]>;
  /** Close a card whose wait ended elsewhere, with its receipt, claimed once. True when this call posted it. */
  settleAttention?(key: WaitKey): Promise<boolean>;
  /**
   * What a board said is still waiting, every pass it answered: the fleet Live Activity drops the
   * waits missing from it and shows again the ones a restart forgot (`fleet-attention.ts`). Not
   * called for a board that could not be read.
   */
  onBoardAttention?(boardId: string, waiting: AttentionPendingDelivery[]): Promise<void>;
  /**
   * Finish escalations owed to an admin who joined the board room, where a send failed
   * (`retryEscalationReposts`). Called for a board that answered this pass.
   */
  retryJoinReposts?(boardId: string): Promise<unknown>;
}

/** What the running hub supplies; the rest is built from the bridge's configuration. */
type SweepRest = Pick<
  GateSweepDeps,
  | "tenantIdFor"
  | "project"
  | "settleOutcome"
  | "onBoardPending"
  | "projectDelivery"
  | "settleDelivery"
  | "projectAttention"
  | "settleAttention"
  | "onBoardAttention"
  | "retryJoinReposts"
>;

/** Every way `projectGate` can end. Derived, so a new outcome cannot be forgotten here. */
export type GateOutcomeStatus = ProjectionOutcome["status"];

/**
 * …plus the one thing `projectGate` does not RETURN: it throws.
 *
 * Deliberately not a `ProjectionOutcome` member. That type describes decisions
 * `projectGate` made and can explain; a throw is the absence of a decision, and
 * modelling it as one would put a `failed` branch in front of every caller that
 * only ever wanted to know what happened to the gate. It is the SWEEP's tally
 * key, because the sweep is the thing that must be able to say "this pass
 * delivered nothing" out loud.
 */
export type GateSweepStatus = GateOutcomeStatus | "failed";

/**
 * The outcomes a gate can land in that mean it is STUCK — a person is waiting
 * on an approval that is not in any room, and nothing else is looking.
 *
 * `sent` is a delivery. `already` is a delivery somebody else made, which is
 * the ordinary healthy answer on a sweep pass and would be pure noise if it
 * warned. These three are the ones that were invisible.
 */
const STUCK: readonly GateSweepStatus[] = ["no-room", "no-agent", "no-speaker", "failed"];

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
   *
   * `failed` is the same lesson one round later: a gate whose projection THREW
   * was logged and never counted, so the tally did not add up to `checked` and
   * `stuck` stayed 0 while nothing was being delivered.
   */
  byStatus: Record<GateSweepStatus, number>;
  /** Boards that could not be asked. Named, because an empty sweep and an
   *  unreachable board look identical from the outside. */
  failedBoards: string[];
  /**
   * Room cards settled this pass — gates decided somewhere this hub never heard about.
   *
   * Counted separately from `projected` because they are opposite acts: one puts a question in a
   * room, the other takes a decided one out of contention. A sweep that reported them together
   * could not answer "is anything still being decided behind my back".
   */
  settled: number;
  /**
   * Delivery follow-ups: seen, put in a room by this pass, and those that could be put nowhere
   * (a person owes a live link nobody asked them for), and room cards settled because the board no
   * longer owes them. `failedBoards` could not be read, and settle nothing.
   */
  deliveries: { checked: number; projected: number; stuck: number; settled: number; failedBoards: string[] };
  /** Waiting cards, counted as follow-ups are: seen, posted by this pass, stuck, and settled. */
  attention: { checked: number; projected: number; stuck: number; settled: number; failedBoards: string[] };
}

/** One sweep pass. Deps are injected so this runs with no network and no db. */
export async function sweepGates(deps: GateSweepDeps): Promise<GateSweepResult> {
  let checked = 0;
  let projected = 0;
  let settled = 0;
  const byStatus: Record<GateSweepStatus, number> = {
    sent: 0,
    already: 0,
    "no-room": 0,
    "no-agent": 0,
    "no-speaker": 0,
    "awaiting-join": 0,
    failed: 0,
  };
  const failedBoards: string[] = [];
  const deliveries: GateSweepResult["deliveries"] = { checked: 0, projected: 0, stuck: 0, settled: 0, failedBoards: [] };
  const attention: GateSweepResult["attention"] = { checked: 0, projected: 0, stuck: 0, settled: 0, failedBoards: [] };

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

    if (deps.onBoardPending) {
      await deps.onBoardPending(boardId, gates.filter(isGatePending)).catch((err) =>
        log.warn("could not report a board's pending gates to the fleet card", {
          boardId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
        // **Counted, not merely logged** — fix round 2. A throw used to leave
        // `byStatus` untouched, so a pass in which every gate threw reported
        // `stuck: 0` and a tally that did not add up to `checked`: the sweep
        // saying nothing was wrong while nothing had been delivered. That is
        // the same defect one level up that this whole tally was added to
        // close on 2026-08-31, and an identity move that leaves a station
        // answering as an mxid its room does not contain is a live way to
        // reach it (`gates.ts`'s send, and `identity-move.ts`).
        byStatus.failed++;
        log.warn("could not project a gate", {
          gateId: gate.gateId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    /**
     * The other direction: a gate this hub posted that the board no longer calls pending.
     *
     * Deliberately inside the loop and AFTER the `continue` above, so a board that could not be
     * asked settles nothing on it. "Not in the pending set" means "decided" only when we actually
     * have the pending set; when the read failed it means "we do not know", and acting on that
     * would take a live question out of a room because the network was down for five minutes.
     */
    const stillPending = new Set(gates.filter(isGatePending).map((g) => g.gateId));
    for (const posted of (await deps.postedGatesAwaitingOutcome?.(boardId)) ?? []) {
      if (stillPending.has(posted.gateId)) continue;
      try {
        const decided = await deps.decisionFor?.(boardId, posted.gateId);
        // Absence is not a decision. A board that cannot say WHAT was decided leaves the card
        // alone: posting "resolved" without the outcome would be inventing one, and a room that
        // says a gate was decided but not how is worse than one that still asks.
        if (!decided) continue;
        if (
          await deps.settleOutcome?.(posted.gateId, decided.decision, decided.decidedBy, decided.chosen ?? null, decided.heldUntil ?? null)
        ) {
          settled++;
          log.info("settled a room card for a gate decided elsewhere", {
            gateId: posted.gateId,
            boardId,
            decision: decided.decision,
          });
        }
      } catch (err) {
        // One card that will not settle must not strand the rest; the next pass tries again,
        // because `outcome_posted_at` is still null.
        log.warn("could not settle a room card", {
          gateId: posted.gateId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await sweepDeliveries(boardId, tenantId, deps, deliveries);
    await sweepAttention(boardId, tenantId, deps, attention);
    await deps.retryJoinReposts?.(boardId).catch((err: unknown) =>
      log.warn("could not retry escalations owed to an admin who joined", { boardId, error: String(err) }),
    );
  }

  const stuck = STUCK.reduce((n, status) => n + byStatus[status], 0);
  if (stuck > 0) {
    // One line an operator can alert on, with the tally beside it — the
    // per-gate warns above say which, this says how bad.
    log.warn("pending gates the sweep could not deliver", { stuck, ...byStatus });
  }

  return { checked, projected, byStatus, failedBoards, settled, deliveries, attention };
}

/**
 * One board's delivery follow-ups: read, and each posted once. A board whose list cannot be read
 * is counted and stepped over, and so is a follow-up whose post throws — the same per-board,
 * per-item isolation as the gates above.
 */
async function sweepDeliveries(
  boardId: string,
  tenantId: string,
  deps: GateSweepDeps,
  tally: GateSweepResult["deliveries"],
): Promise<void> {
  if (!deps.pendingDeliveries || !deps.projectDelivery) return;
  let pending: unknown[];
  try {
    pending = await deps.pendingDeliveries(boardId);
  } catch (err) {
    tally.failedBoards.push(boardId);
    log.warn("could not ask a board for its pending delivery follow-ups", {
      boardId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  for (const d of pending) {
    if (!isDeliveryPending(d)) {
      log.error("board described a delivery follow-up in an unknown shape", { boardId });
      continue;
    }
    tally.checked++;
    try {
      const outcome = await deps.projectDelivery(tenantId, d);
      if (outcome.status === "posted") {
        tally.projected++;
        log.warn("a delivery follow-up reached its room only by sweep", { gateId: d.gateId, boardId });
      } else if (outcome.status === "no-room" || outcome.status === "not-accepted") {
        tally.stuck++;
        log.warn("a delivery follow-up could not be put in a room", { gateId: d.gateId, boardId, status: outcome.status });
      }
    } catch (err) {
      tally.stuck++;
      log.warn("could not project a delivery follow-up", {
        gateId: d.gateId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Only now, with a list the board actually answered with: absent from it means settled on the
  // board. A failed read returned above, so it settles nothing — the gate sweep's rule.
  const stillOwed = new Set(pending.filter(isDeliveryPending).map((d) => d.gateId));
  for (const posted of (await deps.postedDeliveriesAwaitingOutcome?.(boardId)) ?? []) {
    if (stillOwed.has(posted.gateId)) continue;
    try {
      if (await deps.settleDelivery?.(posted.gateId)) {
        tally.settled++;
        log.info("settled a room card for a delivery follow-up settled on the board", { gateId: posted.gateId, boardId });
      }
    } catch (err) {
      log.warn("could not settle a delivery follow-up", {
        gateId: posted.gateId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** One wait's identity, as the sweep compares them. */
const waitKeyOf = (k: WaitKey) => `${k.cardId}\u0000${k.waitId}`;

/**
 * One board's waiting cards: read, and each posted once per wait; then the cards this hub posted
 * whose wait the board no longer lists are closed (`settled_elsewhere`). A failed read settles
 * nothing — the gate sweep's rule — and a card that reappears under a new wait id is a new card,
 * so its old one is settled here.
 */
async function sweepAttention(
  boardId: string,
  tenantId: string,
  deps: GateSweepDeps,
  tally: GateSweepResult["attention"],
): Promise<void> {
  if (!deps.pendingAttention || !deps.projectAttention) return;
  let pending: unknown[];
  try {
    pending = await deps.pendingAttention(boardId);
  } catch (err) {
    tally.failedBoards.push(boardId);
    log.warn("could not ask a board for its waiting cards", {
      boardId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const waiting: AttentionPendingDelivery[] = [];
  for (const d of pending) {
    if (!isAttentionPending(d) || d.boardId !== boardId) {
      log.error("board described a waiting card in an unknown shape", { boardId });
      continue;
    }
    waiting.push(d);
    tally.checked++;
    try {
      const outcome = await deps.projectAttention(tenantId, d);
      if (outcome.status === "posted") {
        tally.projected++;
        log.warn("a waiting card reached its room only by sweep", { cardId: d.cardId, waitId: d.waitId, boardId });
      } else if (outcome.status === "no-room" || outcome.status === "not-accepted") {
        tally.stuck++;
        log.warn("a waiting card could not be put in a room", { cardId: d.cardId, waitId: d.waitId, boardId, status: outcome.status });
      }
    } catch (err) {
      tally.stuck++;
      log.warn("could not project a waiting card", {
        cardId: d.cardId,
        waitId: d.waitId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deps.onBoardAttention) {
    await deps.onBoardAttention(boardId, waiting).catch((err) =>
      log.warn("could not report a board's waiting cards to the fleet card", {
        boardId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // Only now, with a list the board actually answered with: absent from it means the wait ended.
  const stillWaiting = new Set(waiting.map(waitKeyOf));
  for (const posted of (await deps.postedAttentionAwaitingOutcome?.(boardId)) ?? []) {
    if (stillWaiting.has(waitKeyOf(posted))) continue;
    try {
      if (await deps.settleAttention?.(posted)) {
        tally.settled++;
        log.info("settled a waiting card whose wait ended elsewhere", { ...posted });
      }
    } catch (err) {
      log.warn("could not settle a waiting card", {
        ...posted,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The board-facing half of the sweep, built from the bridge's own configuration.
 *
 * The boards this hub works and the credential for each are already in
 * `SUPERPIPELINE_BRIDGE_AGENTS` — the sweep needs no configuration of its own, and
 * giving it any would create a second place for the board list to be wrong.
 *
 * **A board is read with its own board's token.** An agent's `spa_` credential
 * is scoped to the board it claims on, so using the wrong one is a 401 that
 * arrives as `failedBoards` — a board that "could not be reached" rather than a
 * credential that was refused. Deduplicated because two agents on one board is
 * ordinary and asking the same board twice would recover, and log, every gate
 * twice.
 */
export function bridgeGateSweepDeps(
  config: BridgeConfig,
  rest: SweepRest,
  fetchImpl: Fetcher = fetchAdapter,
  roster: (() => Promise<Array<{ boardId: string; token: string }>>) | undefined = defaultRoster,
): GateSweepDeps {
  /**
   * Which credential to ask each board with, read PER SWEEP rather than once at start.
   *
   * It used to be built once from the environment roster, which was the only roster there was.
   * Now the roster is a table an operator edits from the console, so a board added at noon would
   * have gone unswept until the next hub restart, and a rotated token would have gone on being
   * refused with a 401 that arrives as "this board could not be reached". Five minutes apart, one
   * small query, and the sweep is always asking with what the bridge is actually claiming with.
   */
  const tokensForBoards = () => boardCredentials(roster ?? defaultRoster);

  return {
    ...rest,
    boards: async () => [...(await tokensForBoards()).keys()],
    pendingGates: async (boardId) => {
      const token = (await tokensForBoards()).get(boardId);
      if (!token) return [];
      return new SuperpipelineClient({
        baseUrl: config.baseUrl,
        boardId,
        token,
        fetch: fetchImpl,
      }).pendingGates();
    },

    postedDeliveriesAwaitingOutcome: async (boardId) => {
      const { postedDeliveriesAwaitingOutcome } = await import("./delivery-projection");
      return postedDeliveriesAwaitingOutcome(boardId);
    },

    // No credential is not "nothing owed": a throw is read as "could not be read".
    pendingDeliveries: async (boardId) => {
      const token = (await tokensForBoards()).get(boardId);
      if (!token) throw new Error(`no bridge credential for board ${boardId}`);
      return new SuperpipelineClient({ baseUrl: config.baseUrl, boardId, token, fetch: fetchImpl }).pendingDeliveries();
    },

    postedAttentionAwaitingOutcome: async (boardId) => {
      const { postedAttentionAwaitingOutcome } = await import("./attention-projection");
      return postedAttentionAwaitingOutcome(boardId);
    },

    // No credential is not "nothing waiting": a throw is read as "could not be read".
    pendingAttention: async (boardId) => {
      const token = (await tokensForBoards()).get(boardId);
      if (!token) throw new Error(`no bridge credential for board ${boardId}`);
      return new SuperpipelineClient({ baseUrl: config.baseUrl, boardId, token, fetch: fetchImpl }).pendingAttention();
    },

    /**
     * Gates this hub put in a room and never posted an outcome for.
     *
     * The table is the record of what we projected; `outcome_posted_at IS NULL` is the record of
     * what we have not settled. Neither is knowable from superpipeline, which is why this half of
     * the sweep reads locally and the other half reads the board.
     */
    postedGatesAwaitingOutcome: async (boardId) => {
      const { db } = await import("../../db/drizzle");
      const { matrixGateEvents } = await import("../../db/schema/matrix");
      const { and, eq, isNull } = await import("drizzle-orm");
      const rows = await db
        .select({ gateId: matrixGateEvents.gateId, cardId: matrixGateEvents.cardId })
        .from(matrixGateEvents)
        .where(and(eq(matrixGateEvents.boardId, boardId), isNull(matrixGateEvents.outcomePostedAt)));
      return rows;
    },

    readGate: async (boardId, gateId) => {
      const token = (await tokensForBoards()).get(boardId);
      if (!token) return null;
      return new SuperpipelineClient({ baseUrl: config.baseUrl, boardId, token, fetch: fetchImpl }).gate(gateId);
    },

    readChecks: async (boardId, cardId) => {
      const token = (await tokensForBoards()).get(boardId);
      if (!token) return null;
      return new SuperpipelineClient({ baseUrl: config.baseUrl, boardId, token, fetch: fetchImpl }).cardChecks(cardId);
    },

    decisionFor: async (boardId, gateId) => {
      const token = (await tokensForBoards()).get(boardId);
      if (!token) return null;
      const g = await new SuperpipelineClient({ baseUrl: config.baseUrl, boardId, token, fetch: fetchImpl }).gate(gateId);
      // Only a RESOLVED gate settles a card. A gate that is somehow neither pending nor resolved
      // is a shape this hub does not model, and guessing at it would put a wrong word in a room.
      if (!g || g.status !== "resolved" || !g.decision) return null;
      // A held approval pulled back before this hub closed its card (charter 2026-11-09, an approval
      // may wait for its release time §4) went back for rework: the card reads as changes requested,
      // by whoever pulled it back, never as an approval that will act.
      if (g.pulledBack) return { decision: "request_changes", decidedBy: g.pulledBack.by, chosen: null };
      return { decision: g.decision, decidedBy: g.decidedBy, chosen: g.chosen, heldUntil: heldUntilOf(g.heldUntil) };
    },
  };
}

/**
 * Board → the credential to ask it with: the first rostered agent on each board.
 *
 * Shared by the sweep and the push subscription so both speak to a board as the same agent.
 */
async function boardCredentials(
  roster: () => Promise<Array<{ boardId: string; token: string }>>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const agent of await roster()) {
    if (!map.has(agent.boardId)) map.set(agent.boardId, agent.token);
  }
  return map;
}

/**
 * The rostered agents of every workspace, decrypted. Separated so a test can supply its own
 * without a database. A board is one workspace's (`tenantIdFor` answers which), so every tenant's
 * roster is read and each board's gates are projected into its own tenant.
 */
async function defaultRoster(): Promise<Array<{ boardId: string; token: string }>> {
  const { readEveryBridgeRoster } = await import("../bridge/roster");
  return readEveryBridgeRoster();
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
 * `startSuperpipelineBridge` follows. It also means any error logged from in here
 * belongs to something the operator actually turned on.
 */
export function startGateSweeper(
  rest: SweepRest,
  opts: {
    config?: BridgeConfig | null;
    intervalMs?: number;
    /** Test seam: the rostered agents, in place of the table. */
    roster?: () => Promise<Array<{ boardId: string; token: string }>>;
    /** Test seam: how superpipeline is reached. */
    fetch?: Fetcher;
    /**
     * Subscribe every board to this hub's signed push route — at start and on every pass, so a
     * board added, rebuilt, or a rotated secret is repaired within one interval. Without it no
     * board pushes and every gate waits for the sweep. See `bridge/push-subscription.ts`.
     */
    push?: { secret: string | undefined; publicUrl: string; relay?: SuperpipelineRelay | null; tenantsForBoard?: TenantsForBoard };
  } = {},
): (() => void) | null {
  const config =
    opts.config !== undefined ? opts.config : isBridgeEnabled() ? loadBridgeConfig() : null;
  if (!config) return null;

  const fetchImpl = opts.fetch ?? fetchAdapter;
  const deps = bridgeGateSweepDeps(config, rest, fetchImpl, opts.roster);
  running = deps;
  const subscribe = pushSubscriber(config, fetchImpl, opts.roster ?? defaultRoster, opts.push, rest.tenantIdFor);
  void subscribe();
  const timer = setInterval(() => {
    void subscribe();
    void sweepGates(deps).catch((err) =>
      log.error("gate sweep failed", { error: err instanceof Error ? err.message : String(err) }),
    );
  }, opts.intervalMs ?? GATE_SWEEP_INTERVAL_MS);

  // No board count: the roster is read per sweep now, so there is no number to report here that
  // would still be true five minutes later.
  log.info("gate sweep started", { intervalMs: opts.intervalMs ?? GATE_SWEEP_INTERVAL_MS });
  return () => {
    clearInterval(timer);
    if (running === deps) running = null;
  };
}

/** The deps of the sweeper this process started, so a join can borrow them. */
let running: GateSweepDeps | null = null;

/**
 * Sweep one board now, with the running sweeper's own deps; null when none is running.
 *
 * Called when a human joins a board room (`board-room.ts`, `boardForHumanJoin`): a gate
 * held because nobody had joined yet (`awaiting-join`, 2026-10-07) is posted the moment
 * they do, rather than at the next five-minute pass. A board this hub does not work is
 * filtered out by the same roster the periodic pass reads.
 */
export async function sweepBoardNow(boardId: string): Promise<GateSweepResult | null> {
  const deps = running;
  if (!deps) return null;
  return sweepGates({
    ...deps,
    boards: async () => (await deps.boards()).filter((b) => b === boardId),
  });
}

/**
 * One push-subscription pass, logged so an operator can tell "subscribed" from "never tried".
 *
 * Logs a board's subscription when it first succeeds (or recovers), and every refusal — not a
 * line per board per five minutes forever. A missing secret is said once: the push route refuses
 * every delivery without it, so registering would only queue pushes that are bound to fail.
 */
function pushSubscriber(
  config: BridgeConfig,
  fetchImpl: Fetcher,
  roster: () => Promise<Array<{ boardId: string; token: string }>>,
  push: { secret: string | undefined; publicUrl: string; relay?: SuperpipelineRelay | null; tenantsForBoard?: TenantsForBoard } | undefined,
  tenantIdFor: (boardId: string) => Promise<string | null>,
): () => Promise<void> {
  if (!push) return async () => {};
  if (!push.secret) {
    log.warn("push subscription skipped: SUPERPIPELINE_PUSH_SECRET is unset; gates arrive by sweep only");
    return async () => {};
  }
  const subscribed = new Set<string>();
  const relayed = new Set<string>();
  const relay = push.relay ?? null;
  return async () => {
    try {
      const result = await subscribeBoardsToPush({
        baseUrl: config.baseUrl,
        publicUrl: push.publicUrl,
        secret: push.secret,
        fetch: fetchImpl,
        boards: () => boardCredentials(roster),
        // The relay's token only for a board of the relay's own workspace (`relay.ts`).
        ...(relay
          ? {
              relayTokenFor: async (boardId: string) =>
                relayTokenForBoard(relay, await tenantIdFor(boardId), boardId, push.tenantsForBoard),
              onRelayRefused: () => relay.invalidate(),
            }
          : {}),
      });
      for (const boardId of result.subscribed) {
        if (!subscribed.has(boardId)) log.info("push subscription registered", { boardId });
        subscribed.add(boardId);
      }
      for (const boardId of result.relayed) {
        if (!relayed.has(boardId)) log.info("relay push subscription registered", { boardId });
        relayed.add(boardId);
      }
      for (const f of result.failed) {
        subscribed.delete(f.boardId);
        log.warn("push subscription refused", { boardId: f.boardId, error: f.error });
      }
    } catch (err) {
      log.error("push subscription failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * What a board is waiting on now — its gates, follow-ups and waiting cards — read with the running
 * sweeper's own deps, so an escalated card moved below is rebuilt from the same reads the sweep
 * posts from (`decision-repost.ts`). Throws when no sweeper runs or a read fails.
 */
export async function readBoardPending(boardId: string): Promise<unknown[]> {
  const deps = running;
  if (!deps) throw new Error("no gate sweeper is running");
  const [gates, deliveries, attention] = await Promise.all([
    deps.pendingGates(boardId),
    deps.pendingDeliveries?.(boardId) ?? [],
    deps.pendingAttention?.(boardId) ?? [],
  ]);
  return [...gates, ...deliveries, ...attention];
}

/**
 * One gate as its board reports it now, read with the running sweeper's own credential, or null
 * when no sweeper runs or the board cannot be read. Asked after an approval of a quorum gate was
 * accepted (`gate-decision.ts`), because only the board knows whether that approval passed it.
 */
export async function readBoardGate(
  boardId: string,
  gateId: string,
): Promise<{
  status: string;
  decision: string | null;
  decidedBy: string | null;
  chosen: { id: string; label: string } | null;
  heldUntil?: string | null;
} | null> {
  return (await running?.readGate?.(boardId, gateId)) ?? null;
}

/**
 * A card's machine checks as its board reads them now, with the running sweeper's own credential, or
 * null when no sweeper runs or there is no credential for the board. Throws when the board cannot be
 * read, so an escalation of overdue checks is retried rather than posted without them.
 */
export async function readBoardCardChecks(
  boardId: string,
  cardId: string,
): Promise<{ stageKey: string; status: string; checks: unknown[] } | null> {
  return (await running?.readChecks?.(boardId, cardId)) ?? null;
}
