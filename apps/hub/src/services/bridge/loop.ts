import { probeSalaamWork } from "./salaam-dispatch";
/**
 * The bridge process: one hub process multiplexing many agent identities, each
 * with its own claim-and-lease loop.
 *
 * One process, not one per agent — the hub already owns the station connections
 * and the ACP session machinery, and a second process would need a second copy
 * of both. What is *not* shared is identity: each loop holds its own `spa_`
 * token, because an agent's authority is its own rather than a projection of
 * whoever dispatched it.
 *
 * Off unless `ENABLE_SUPERPIPELINE_BRIDGE=true`. A hub that has not opted in
 * constructs nothing here and behaves exactly as it does today.
 */

import * as acpSessions from "../acp-sessions";
import { BRIDGE_SOURCE, isBridgeEnabled, type BridgeAgentConfig } from "./config";
import { loopKey, reconcileRoster, type LoopRegistry, type ReconcileState } from "./reconcile";
import { bridgePlaneCredential, readEveryBridgeRoster, type BridgeAgentSecrets } from "./roster";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { runOnce, type AcpPort, type DispatchResult } from "./dispatch";
import { SuperpipelineApiError, SuperpipelineClient, fetchAdapter } from "./superpipeline";
import { createLogger } from "../../utils/logger";

/** How long to wait after a claim that found nothing. */
const DEFAULT_POLL_MS = 5_000;
/** How long to wait after an error, so a broken board is not hammered. */
const DEFAULT_BACKOFF_MS = 30_000;

export interface AgentLoopOptions {
  /**
   * One work cycle. Injected so the loop's control flow is testable alone. `handover` is aborted
   * when the loop is stopped for a rebuild: a strict driver then yields its run to the successor.
   */
  run: (handover: AbortSignal) => Promise<DispatchResult>;
  pollMs?: number;
  backoffMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onFault?: (result: DispatchResult) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface LoopHandle {
  /**
   * Resolves once the loop has left its current cycle. With `handover`, the current cycle is also
   * asked to yield strict work it is driving, so a rebuilt loop can resume it (#776); without it,
   * the cycle drains as before.
   */
  stop(opts?: { handover?: boolean }): Promise<void>;
  /** Resolves when the loop exits on its own — a fault, or a stop. */
  done: Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/**
 * Claim, work, repeat.
 *
 * **A `foreign-run` halts the loop.** It means this agent drove a run belonging
 * to another agent, which is a bug in configuration or in the bridge itself,
 * and claiming again walks straight back into it. A lost lease is the opposite:
 * ordinary, expected, and a reason to claim again immediately — the card has
 * been re-queued and someone should pick it up.
 */
export function startAgentLoop(opts: AgentLoopOptions): LoopHandle {
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? (() => {});
  const controller = new AbortController();
  const handover = new AbortController();

  const done = (async () => {
    let cycle = 0;
    let lastFailedRun: string | undefined;
    while (!controller.signal.aborted) {
      // **Liveness, not decoration.** Twice now a bridge agent has stopped and left nothing
      // behind: a 401 retried into noise, then a cycle that never came back. Both were invisible
      // because a loop that is neither erroring nor idling logs nothing at all, and a silent
      // agent is indistinguishable from a quiet board.
      //
      // One line per cycle at DEBUG-ish volume — a cycle is at minimum five seconds — is a cheap
      // price for being able to answer "is it still going round?" without attaching a debugger
      // to production, which is exactly the question that could not be answered on 2026-09-08.
      log("cycle", { n: ++cycle });
      let result: DispatchResult;
      try {
        // NOT bounded by a deadline, and that is deliberate. `runOnce` drives the claimed run
        // to completion — it creates the session, prompts, streams activities and heartbeats —
        // so a legitimate cycle lasts as long as the agent's work, and `permissionWaitMs`
        // alone defaults to thirty minutes. A cycle deadline here would abandon real work
        // mid-run. What must be fast is the READINESS PROBE, and that is bounded where it is
        // made, in `dispatch.ts`.
        result = await opts.run(handover.signal);
      } catch (err) {
        // **An authentication failure is not retryable, and retrying hides it.**
        //
        // A 401 means superpipeline does not recognise this agent's credential; a 403 means it
        // refuses the act. Neither improves by being asked again, and the loop's own backoff
        // turns a misconfiguration into an error line every thirty seconds forever — which is
        // exactly what it did. On 2026-09-04 the hub was found polling a board with a token
        // whose agent had been deleted three days earlier: 8,640 identical 401s a day, and no
        // signal that anything was wrong beyond noise nobody reads.
        //
        // Halts on the same terms as `foreign-run` below: stop, say why once, and let
        // `onFault` surface it. An operator has to change something, so make them look.
        if (err instanceof SuperpipelineApiError && (err.status === 401 || err.status === 403)) {
          log("halting: superpipeline refused this agent's credential", {
            status: err.status,
            path: err.path,
            hint:
              "the token no longer resolves to an agent on that board — re-mint it in superpipeline and " +
              "update this agent under Bridge in the console, or disable it there",
          });
          // Deliberately NOT reported through `onFault`, which takes a DispatchResult: this
          // is not a dispatch outcome, and inventing a status member for it from a catch
          // block would put a fault into the enum every switch has to answer for. The halt
          // is the signal — the agent stops claiming, and the line above says why.
          return;
        }
        log("a claim cycle threw", { error: String(err) });
        await sleep(opts.backoffMs ?? DEFAULT_BACKOFF_MS, controller.signal);
        continue;
      }

      // **A failed dispatch is never silent.** A strict Salaam run that fails on resume
      // used to return here unlogged, and the next cycle resumed it again: 2026-10-23, a
      // card sat "working" through hundreds of cycles with nothing in the log saying why.
      // The same run failing twice in a row also backs off, so a resume loop is not a storm.
      if (result.status === "failed") {
        log("the dispatch failed", { run: result.externalRunId, reason: result.reason });
        const repeat = result.externalRunId !== undefined && result.externalRunId === lastFailedRun;
        lastFailedRun = result.externalRunId;
        if (repeat) await sleep(opts.backoffMs ?? DEFAULT_BACKOFF_MS, controller.signal);
        continue;
      }
      lastFailedRun = undefined;

      if (result.status === "foreign-run") {
        // Never retried, and never claimed past: an agent driving another
        // agent's run repeats until someone looks.
        log("halting: a run belonged to another agent", { run: result.externalRunId });
        opts.onFault?.(result);
        return;
      }

      if (result.status === "idle") {
        await sleep(opts.pollMs ?? DEFAULT_POLL_MS, controller.signal);
        continue;
      }

      // **The anti-storm rule.** Both of these mean the work could not start,
      // and both leave the card claimable — so the next cycle would claim it
      // straight back. At the poll interval that is a claim/release every five
      // seconds for as long as the station is down: a stuck card traded for a
      // busy one and a board full of churn. They wait out the error backoff
      // instead, which is also long enough for a node-agent to reconnect.
      if (result.status === "not-ready" || result.status === "released") {
        log(result.status === "not-ready" ? "the station is not ready; backing off" : "the claim was handed back; backing off", {
          run: result.externalRunId,
          reason: result.reason,
        });
        await sleep(opts.backoffMs ?? DEFAULT_BACKOFF_MS, controller.signal);
      }
    }
  })();

  return {
    done,
    async stop(stopOpts) {
      if (stopOpts?.handover) handover.abort();
      controller.abort();
      await done;
    },
  };
}

/** The hub's real ACP machinery, behind the port a dispatch talks to. */
const hubAcpPort: AcpPort = {
  strictWork: probeSalaamWork,
  stationReady: ({ stationId, tenantId }) => acpSessions.stationReadiness({ tenantId }, stationId),
  createSession: async (input) => {
    const row = await acpSessions.createSession(input);
    return { id: row.id, libraryTools: acpSessions.sessionHasLibraryTools(row.id) };
  },
  promptSession: (userId, sessionId, text, run) => acpSessions.promptSession(userId, sessionId, text, [], run),
  renewExecution: (userId,sessionId,run) => acpSessions.renewExecution(userId,sessionId,run),
  subscribe: (sessionId, fn) => acpSessions.subscribe(sessionId, fn),
  endSession: (userId, sessionId, reason) => acpSessions.endSession(userId, sessionId, reason),
  answerPermission: (userId, sessionId, requestSeq, optionId) =>
    acpSessions.answerPermission(userId, sessionId, requestSeq, optionId),
};

/**
 * `deps.log` takes (message, meta) with no level, so the default sink derives one: a halt is an
 * error, anything carrying an `error` in its meta is a warning, the rest is routine.
 */
export function bridgeLogLevel(message: string, meta?: Record<string, unknown>): "info" | "warn" | "error" {
  if (message.startsWith("halting")) return "error";
  if (meta && meta.error !== undefined) return "warn";
  return "info";
}

export interface BridgeHandle {
  /** The keys currently running. Changes as the roster does. */
  readonly agents: string[];
  stop(): Promise<void>;
}

/** How often the roster is re-read. A console edit takes effect within one of these. */
const RECONCILE_MS = 10_000;

/**
 * Supervise a loop per rostered agent, or return null when the bridge is off.
 *
 * Called from `src/index.ts` after the sweeper, mirroring `registerEnabledProvisioners()`: a
 * subsystem that is off is not constructed.
 *
 * **This used to read an environment variable once and be done.** The roster is a table now
 * (`services/bridge/roster.ts`), so this became a supervisor: it ticks, diffs, and starts or stops
 * loops to match. An agent added in the console starts claiming within `RECONCILE_MS` with no
 * restart, which is the whole reason the roster moved.
 */
export async function startSuperpipelineBridge(
  deps: {
    acp?: AcpPort;
    log?: (m: string, meta?: Record<string, unknown>) => void;
    /** Test seam: the roster to reconcile against, in place of the table. */
    roster?: () => Promise<BridgeAgentSecrets[]>;
    reconcileMs?: number;
  } = {},
): Promise<BridgeHandle | null> {
  if (!isBridgeEnabled()) return null;

  const baseUrl = (process.env.SUPERPIPELINE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return null;

  const acp = deps.acp ?? hubAcpPort;
  const bridgeLog = createLogger("bridge");
  const log =
    deps.log ?? ((m: string, meta?: Record<string, unknown>) => bridgeLog[bridgeLogLevel(m, meta)](m, meta));
  /**
   * superpipeline serves MCP at one origin-level path, not per board — the board is the agent's,
   * carried by its credential (`apps/api/src/index.ts`, `path === '/mcp'`). Derived from the
   * configured base URL rather than configured separately: two settings that must agree are one
   * setting an operator can get wrong.
   */
  const mcpUrl = new URL("/mcp", baseUrl).toString();

  const live = new Map<string, { handle: LoopHandle; revision: string }>();
  const state: ReconcileState = {};

  const registry: LoopRegistry = {
    running: () => new Map([...live].map(([k, v]) => [k, v.revision])),
    start(agent) {
      // Never two loops on one key: a second would be orphaned here, unstoppable by any later
      // roster edit, and would drive the same strict run as the first (#776).
      if (live.has(loopKey(agent)))
        throw new Error("a loop is already running for this agent");
      const config: BridgeAgentConfig = {
        key: agent.key,
        boardId: agent.boardId,
        token: agent.token,
        stationId: agent.stationId,
        hubUserId: agent.hubUserId,
        mode: agent.mode,
        ...(agent.permissionWaitMs !== null ? { permissionWaitMs: agent.permissionWaitMs } : {}),
        ...(agent.maxConcurrency !== null ? { maxConcurrency: agent.maxConcurrency } : {}),
        ...(agent.profileKey !== null ? { profileKey: agent.profileKey } : {}),
        ...(agent.mcpToken !== null ? { mcpToken: agent.mcpToken } : {}),
      };
      const client = new SuperpipelineClient({
        baseUrl,
        boardId: agent.boardId,
        token: agent.token,
        ...(agent.credentialSource ? {credential: bridgePlaneCredential(agent)} : {}),
        fetch: fetchAdapter,
      });
      const handle = startAgentLoop({
        run: async (handover) =>
          runOnce({
            handover,
            client,
            acp,
            agent: config,
            // The roster row's own tenant (W5): the composite FK pins it to its station's, so the
            // ledger rows land where the station lives. A test-seam roster without one is the
            // tenant the roster below is read from.
            tenantId: agent.tenantId ?? BOOTSTRAP_TENANT_ID,
            source: BRIDGE_SOURCE,
            log,
            mcpUrl,
          }),
        log: (m, meta) => log(m, { agent: agent.key, ...meta }),
      });
      live.set(loopKey(agent), { handle, revision: agent.revision });
      log("claiming", describe(config, baseUrl));
    },
    async stop(key, why = "removed") {
      const entry = live.get(key);
      if (!entry) return;
      // Drain, not abandon: `stop()` waits for the in-flight card. See `LoopRegistry.stop`. A
      // rebuild hands strict work over instead, because the successor resumes it.
      log(
        why === "rebuild"
          ? "the row was edited; handing the current card to the rebuilt loop"
          : "no longer rostered; finishing the current card and stopping",
        { agent: key },
      );
      await entry.handle.stop({ handover: why === "rebuild" });
      live.delete(key);
    },
  };

  const readRoster =
    deps.roster ??
    (() =>
      // Every workspace's roster, each entry read under its own tenant (workspace authority, step 4).
      readEveryBridgeRoster((key, error) =>
        log("an agent's credential could not be read; it is not being claimed with", { agent: key, error }),
      ));

  const tick = async () => {
    try {
      await reconcileRoster(registry, await readRoster(), {
        state,
        onEmpty: () =>
          log(
            "enabled, but no agents are rostered — nothing will be claimed. Add one under " +
              "Bridge in the console.",
          ),
        onError: (key, error) => log("an agent could not be started", { agent: key, error }),
      });
    } catch (err) {
      // A database blip must not kill the supervisor: the next tick tries again.
      log("the roster could not be read", { error: String(err) });
    }
  };

  await tick();
  const timer = setInterval(() => void tick(), deps.reconcileMs ?? RECONCILE_MS);

  return {
    get agents() {
      return [...live.keys()];
    },
    async stop() {
      clearInterval(timer);
      await Promise.all([...live.values()].map((l) => l.handle.stop()));
      live.clear();
    },
  };
}

const describe = (agent: BridgeAgentConfig, baseUrl: string) => ({
  agent: agent.key,
  board: agent.boardId,
  station: agent.stationId,
  mode: agent.mode,
  baseUrl,
});
