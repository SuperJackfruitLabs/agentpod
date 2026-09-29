/**
 * Bring the running loops into line with the roster table.
 *
 * The roster used to be an environment variable read once at boot, so changing it meant root on
 * the hub host and a restart. It is a table now, and this is what makes an edit take effect: a
 * tick, a desired state, and a diff — the shape `services/node-sweeper.ts` already establishes.
 *
 * Deliberately knows nothing about Postgres or about `startAgentLoop`. It is handed the roster and
 * a registry, so what it does — start, stop, rebuild — is testable without either.
 */

import type { BridgeAgentSecrets } from "./roster";

/** The live loops, as the reconciler is allowed to see and change them. */
export interface LoopRegistry {
  /** Key → the revision the running loop was built from. */
  running(): Map<string, string>;
  start(agent: BridgeAgentSecrets): void;
  /**
   * Stop one, and resolve only once it has actually stopped.
   *
   * `LoopHandle.stop()` is drain-safe and this design depends on it: in `startAgentLoop` the
   * `AbortController`'s signal reaches only `sleep`, never `opts.run()`, and the abort is checked
   * at the top of each cycle. So a stop aborts the pending sleep and then waits for `done`, which
   * cannot resolve until the in-flight `runOnce` returns. A removed agent finishes the card it is
   * holding and then exits — it does not abandon it mid-run.
   */
  stop(key: string): Promise<void>;
}

/**
 * What the reconciler remembers between ticks.
 *
 * Only one thing, and it exists to keep a log line rare: see `onEmpty`. Held by the caller rather
 * than in module scope so a test can have its own, and so two hubs in one process — which the test
 * suite is — cannot share it.
 */
export interface ReconcileState {
  reportedEmpty?: boolean;
}

export interface ReconcileOptions {
  state?: ReconcileState;
  /**
   * The bridge is on and the roster is empty.
   *
   * This is the protection given up by moving the roster out of the environment: `validateConfig`
   * runs before `initDatabase` and cannot reach the table, so "a bridge that silently claimed
   * nothing looks exactly like a quiet board" is no longer catchable at boot. It is caught here
   * instead — but ONCE per emptying, not once per tick, because a line every few seconds forever
   * is exactly the volume the coalescing work exists to prevent.
   */
  onEmpty?: () => void;
  /** One agent could not be started. The others still are. */
  onError?: (key: string, error: string) => void;
}

/**
 * One pass.
 *
 * Order matters in exactly one place: a rebuilt agent is stopped and *awaited* before it is
 * started again. Overlapping them would put two loops on one agent's credential, and both would
 * claim — which is the one failure mode this whole subsystem is built to avoid.
 */
export async function reconcileRoster(
  registry: LoopRegistry,
  roster: BridgeAgentSecrets[],
  opts: ReconcileOptions = {},
): Promise<void> {
  const state = opts.state;
  if (state) {
    if (roster.length === 0 && !state.reportedEmpty) {
      state.reportedEmpty = true;
      opts.onEmpty?.();
    } else if (roster.length > 0) {
      state.reportedEmpty = false;
    }
  } else if (roster.length === 0) {
    opts.onEmpty?.();
  }

  const running = registry.running();
  const wanted = new Map(roster.map((a) => [a.key, a]));

  // Gone, or disabled — `readBridgeRoster` filters disabled rows out, so the two arrive here
  // identically. That is deliberate: the difference matters to a human reading the list, not to
  // the supervisor, which only ever asks "should this be running".
  for (const key of running.keys()) {
    if (!wanted.has(key)) await registry.stop(key);
  }

  for (const [key, agent] of wanted) {
    const live = running.get(key);
    if (live === agent.revision) continue;
    if (live !== undefined) await registry.stop(key);
    try {
      registry.start(agent);
    } catch (err) {
      // One agent with a station that has gone away, or a credential that will not decrypt, must
      // not stop the other three from claiming.
      opts.onError?.(key, err instanceof Error ? err.message : String(err));
    }
  }
}
