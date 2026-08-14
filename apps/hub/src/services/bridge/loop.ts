/**
 * The bridge process: one hub process multiplexing many agent identities, each
 * with its own claim-and-lease loop.
 *
 * One process, not one per agent — the hub already owns the station connections
 * and the ACP session machinery, and a second process would need a second copy
 * of both. What is *not* shared is identity: each loop holds its own `kbn_`
 * token, because an agent's authority is its own rather than a projection of
 * whoever dispatched it.
 *
 * Off unless `ENABLE_KAAMBAAN_BRIDGE=true`. A hub that has not opted in
 * constructs nothing here and behaves exactly as it does today.
 */

import { resolveTenantForUser } from "../../auth/tenant";
import * as acpSessions from "../acp-sessions";
import { isBridgeEnabled, loadBridgeConfig, type BridgeAgentConfig } from "./config";
import { runOnce, type AcpPort, type DispatchResult } from "./dispatch";
import { KaambaanClient } from "./kaambaan";

/** How long to wait after a claim that found nothing. */
const DEFAULT_POLL_MS = 5_000;
/** How long to wait after an error, so a broken board is not hammered. */
const DEFAULT_BACKOFF_MS = 30_000;

export interface AgentLoopOptions {
  /** One work cycle. Injected so the loop's control flow is testable alone. */
  run: () => Promise<DispatchResult>;
  pollMs?: number;
  backoffMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onFault?: (result: DispatchResult) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface LoopHandle {
  /** Resolves once the loop has left its current cycle. */
  stop(): Promise<void>;
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

  const done = (async () => {
    while (!controller.signal.aborted) {
      let result: DispatchResult;
      try {
        result = await opts.run();
      } catch (err) {
        log("a claim cycle threw", { error: String(err) });
        await sleep(opts.backoffMs ?? DEFAULT_BACKOFF_MS, controller.signal);
        continue;
      }

      if (result.status === "foreign-run") {
        // Never retried, and never claimed past: an agent driving another
        // agent's run repeats until someone looks.
        log("halting: a run belonged to another agent", { run: result.externalRunId });
        opts.onFault?.(result);
        return;
      }

      if (result.status === "idle") {
        await sleep(opts.pollMs ?? DEFAULT_POLL_MS, controller.signal);
      }
    }
  })();

  return {
    done,
    async stop() {
      controller.abort();
      await done;
    },
  };
}

/** The hub's real ACP machinery, behind the port a dispatch talks to. */
const hubAcpPort: AcpPort = {
  createSession: (input) => acpSessions.createSession(input),
  promptSession: (userId, sessionId, text) => acpSessions.promptSession(userId, sessionId, text),
  subscribe: (sessionId, fn) => acpSessions.subscribe(sessionId, fn),
  endSession: (userId, sessionId, reason) => acpSessions.endSession(userId, sessionId, reason),
};

export interface BridgeHandle {
  agents: string[];
  stop(): Promise<void>;
}

/**
 * Start a loop per configured agent, or return null when the bridge is off.
 *
 * Called from `src/index.ts` after the sweeper, mirroring
 * `registerEnabledProvisioners()`: a subsystem that is off is not constructed.
 */
export async function startKaambaanBridge(
  deps: { acp?: AcpPort; log?: (m: string, meta?: Record<string, unknown>) => void } = {},
): Promise<BridgeHandle | null> {
  if (!isBridgeEnabled()) return null;
  const config = loadBridgeConfig();
  if (!config) return null;

  const acp = deps.acp ?? hubAcpPort;
  const log = deps.log ?? ((m: string, meta?: Record<string, unknown>) => console.log(`[bridge] ${m}`, meta ?? ""));

  const loops: LoopHandle[] = [];
  for (const agent of config.agents) {
    const tenantId = await resolveTenantForUser(agent.hubUserId);
    const client = new KaambaanClient({
      baseUrl: config.baseUrl,
      boardId: agent.boardId,
      token: agent.token,
      fetch: fetchAdapter,
    });

    loops.push(
      startAgentLoop({
        run: () => runOnce({ client, acp, agent, tenantId, source: config.source, log }),
        log: (m, meta) => log(m, { agent: agent.key, ...meta }),
      }),
    );
    log("claiming", describe(agent, config.baseUrl));
  }

  return {
    agents: config.agents.map((a) => a.key),
    async stop() {
      await Promise.all(loops.map((l) => l.stop()));
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

/** Global `fetch`, narrowed to the shape the client injects. */
const fetchAdapter = async (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => {
  const res = await fetch(url, init);
  return { status: res.status, ok: res.ok, json: () => res.json() as Promise<unknown> };
};
