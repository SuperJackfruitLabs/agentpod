/**
 * The floor beneath push, for an agent's questions.
 *
 * A delivery is retried five times and then dead-lettered, at which point a card is
 * blocked on an answer nobody was told about and neither side is looking. That is the
 * half `gate-sweep.ts` already has, and this is its mirror.
 *
 * **The other half matters more here than it does for gates.** A gate stops being
 * pending only by being decided. A question is also retired the moment the same agent
 * asks the next one — the board does that itself — so a room can hold a card for a
 * question nobody can answer any more. A stale question that still looks answerable is
 * one that will be answered, by somebody who then watches nothing happen.
 *
 * Absence from the board's pending list is the signal for both halves, which is why
 * failing to read a board can never be treated as "nothing is pending": that would
 * settle every open question on a timeout.
 */
import { SuperpipelineClient, fetchAdapter, type Fetcher } from "../bridge/superpipeline";
import { isBridgeEnabled, loadBridgeConfig, type BridgeConfig } from "../bridge/config";
import { createLogger } from "../../utils/logger";
import type { ElicitationPendingDelivery } from "./elicitation-card";
import type { ElicitationProjectionOutcome } from "./elicitations";

const log = createLogger("elicitation-sweep");

export interface ElicitationSweepDeps {
  /** The boards this hub works, from the bridge's own configuration. */
  boards(): Promise<string[]>;
  /**
   * Which fleet a board's questions belong to, or null when this hub never worked it
   * — in which case no card on it was ever dispatched to a station, so no question on
   * it can have a room.
   */
  tenantIdFor(boardId: string): Promise<string | null>;
  /** What the board is still waiting on, read with the bridge's own token. */
  pendingElicitations(boardId: string): Promise<ElicitationPendingDelivery[]>;
  /** Post the question, exactly once. Idempotent on `elicitation_id`. */
  project(tenantId: string, d: ElicitationPendingDelivery): Promise<ElicitationProjectionOutcome>;
  /** Questions this hub put in a room and has not yet said anything final about. */
  postedAwaitingOutcome(boardId: string): Promise<Array<{ elicitationId: string; roomId: string }>>;
  /** Say in the room that it is over, and claim it so two sweeps leave one line. */
  settle(elicitationId: string, roomId: string): Promise<boolean>;
}

export interface ElicitationSweepResult {
  /** Questions this pass actually put in a room. */
  projected: number;
  /**
   * Questions that could not be put anywhere.
   *
   * Counted rather than logged and forgotten: a person is waiting on a question that
   * is in no room, and this is the only thing looking.
   */
  stuck: number;
  /** Room cards closed for questions that are over. */
  settled: number;
  /** Boards that did not answer. Their questions are NOT therefore closed. */
  boardsUnread: number;
  /**
   * Questions held because nobody has joined their board room yet. Waiting on a person,
   * not stuck; posted by the next pass, or at once by the join (`sweepElicitationBoardNow`).
   */
  awaitingJoin: number;
}

/**
 * `already` is the ordinary healthy answer on a sweep pass — push got there first —
 * and counting it as a delivery would make every pass look busy. Everything that is
 * not a delivery and not `already` is a question nobody can see.
 */
function countsAsStuck(status: ElicitationProjectionOutcome["status"]): boolean {
  return status !== "posted" && status !== "already" && status !== "awaiting-join";
}

export async function sweepElicitations(deps: ElicitationSweepDeps): Promise<ElicitationSweepResult> {
  const result: ElicitationSweepResult = {
    projected: 0,
    stuck: 0,
    settled: 0,
    boardsUnread: 0,
    awaitingJoin: 0,
  };

  for (const boardId of await deps.boards()) {
    const tenantId = await deps.tenantIdFor(boardId);
    if (!tenantId) continue;

    let pending: ElicitationPendingDelivery[];
    try {
      pending = await deps.pendingElicitations(boardId);
    } catch (err) {
      // One unreachable board must not cost every other board its sweep — and must
      // not look like a board with nothing pending, which is the shape that would
      // settle every open question on it.
      result.boardsUnread += 1;
      log.warn("board's pending questions could not be read", {
        boardId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const d of pending) {
      try {
        const outcome = await deps.project(tenantId, d);
        if (outcome.status === "posted") result.projected += 1;
        else if (outcome.status === "awaiting-join") result.awaitingJoin += 1;
        else if (countsAsStuck(outcome.status)) {
          result.stuck += 1;
          log.warn("question could not be put in a room", {
            elicitationId: d.elicitationId,
            boardId,
            status: outcome.status,
          });
        }
      } catch (err) {
        // A throw is the absence of a decision, not a decision — but for this tally
        // it means the same thing a `no-room` does: nobody can see the question.
        result.stuck += 1;
        log.warn("projecting a question threw", {
          elicitationId: d.elicitationId,
          boardId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Only now, with a list the board actually answered with.
    const open = new Set(pending.map((p) => p.elicitationId));
    for (const posted of await deps.postedAwaitingOutcome(boardId)) {
      if (open.has(posted.elicitationId)) continue;
      try {
        if (await deps.settle(posted.elicitationId, posted.roomId)) result.settled += 1;
      } catch (err) {
        log.warn("could not settle a question that is over", {
          elicitationId: posted.elicitationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/**
 * Build the sweep's dependencies from the bridge's own configuration.
 *
 * Credentials are read PER SWEEP rather than once at start, for the reason the gate
 * sweeper gives: the roster is a table an operator edits from the console, so a board
 * added at noon would otherwise go unswept until the next restart, and a rotated token
 * would go on being refused with a 401 that arrives as "this board could not be read".
 */
export function bridgeElicitationSweepDeps(
  config: BridgeConfig,
  rest: Pick<ElicitationSweepDeps, "tenantIdFor" | "project" | "postedAwaitingOutcome" | "settle">,
  fetchImpl: Fetcher = fetchAdapter,
  roster: (() => Promise<Array<{ boardId: string; token: string }>>) | undefined = undefined,
): ElicitationSweepDeps {
  const tokensForBoards = async () => {
    const map = new Map<string, string>();
    for (const agent of await (roster ?? bridgeRoster)()) {
      if (!map.has(agent.boardId)) map.set(agent.boardId, agent.token);
    }
    return map;
  };

  return {
    ...rest,
    boards: async () => [...(await tokensForBoards()).keys()],
    pendingElicitations: async (boardId) => {
      const token = (await tokensForBoards()).get(boardId);
      // No credential is not an empty board. Answering `[]` here would settle every
      // question this hub ever posted on it; a throw is read as "could not be read",
      // which settles nothing.
      if (!token) throw new Error(`no bridge credential for board ${boardId}`);
      return new SuperpipelineClient({
        baseUrl: config.baseUrl,
        boardId,
        token,
        fetch: fetchImpl,
      }).pendingElicitations();
    },
  };
}

/** How often the sweep runs. The same cadence as the gate sweep. */
const ELICITATION_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Start the sweep, or do not start it at all.
 *
 * Null rather than a timer over an empty list: most hubs run no bridge, and a
 * subsystem that is off should not be constructed — the rule `startSuperpipelineBridge`
 * and the gate sweeper both follow. It also means anything logged from in here belongs
 * to something the operator actually turned on.
 */
export function startElicitationSweeper(
  rest: Pick<ElicitationSweepDeps, "tenantIdFor" | "project" | "postedAwaitingOutcome" | "settle">,
  opts: {
    config?: BridgeConfig | null;
    intervalMs?: number;
    roster?: () => Promise<Array<{ boardId: string; token: string }>>;
  } = {},
): (() => void) | null {
  const config =
    opts.config !== undefined ? opts.config : isBridgeEnabled() ? loadBridgeConfig() : null;
  if (!config) return null;

  const deps = bridgeElicitationSweepDeps(config, rest, fetchAdapter, opts.roster);
  running = deps;
  const intervalMs = opts.intervalMs ?? ELICITATION_SWEEP_INTERVAL_MS;
  const timer = setInterval(() => {
    void sweepElicitations(deps).catch((err) =>
      log.error("elicitation sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, intervalMs);

  log.info("elicitation sweep started", { intervalMs });
  return () => {
    clearInterval(timer);
    if (running === deps) running = null;
  };
}

/** The deps of the sweeper this process started, so a join can borrow them. */
let running: ElicitationSweepDeps | null = null;

/**
 * Sweep one board's questions now, with the running sweeper's own deps; null when none
 * is running. The join half of the hold (`board-projection.ts`): a question held because
 * nobody had joined its board room is posted the moment somebody does.
 */
export async function sweepElicitationBoardNow(boardId: string): Promise<ElicitationSweepResult | null> {
  const deps = running;
  if (!deps) return null;
  return sweepElicitations({
    ...deps,
    boards: async () => (await deps.boards()).filter((b) => b === boardId),
  });
}

/** The rostered agents, read from the table the console edits. */
async function bridgeRoster(): Promise<Array<{ boardId: string; token: string }>> {
  const { readBridgeRoster } = await import("../bridge/roster");
  const { BOOTSTRAP_TENANT_ID } = await import("../../db/schema/tenants");
  return readBridgeRoster(BOOTSTRAP_TENANT_ID);
}
