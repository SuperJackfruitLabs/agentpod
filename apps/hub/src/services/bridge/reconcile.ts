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

/**
 * Which loop an entry is. A roster key is unique only inside its tenant (`bridge_agents`' key is
 * `(tenant_id, key)`), and the bridge runs every tenant's roster, so two workspaces may both have
 * a `coder`: the tenant is part of the loop's identity. An entry without one (a test seam's
 * roster) is its key.
 */
export function loopKey(agent: Pick<BridgeAgentSecrets, "key" | "tenantId">): string {
  return agent.tenantId ? `${agent.tenantId}/${agent.key}` : agent.key;
}

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
  stop(key: string, why?: "removed" | "rebuild"): Promise<void>;
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
  /**
   * Keys with a stop or rebuild still in progress. A stop drains the in-flight card, which can
   * take as long as the card does, and the supervisor ticks every few seconds meanwhile. Each of
   * those ticks used to see the old loop still registered, call stop again, and then start its own
   * loop when the drain ended: seven loops on one agent (#776), all but one orphaned. A key in
   * here is left alone until its transition is over.
   */
  transitioning?: Set<string>;
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
  const wanted = new Map(roster.map((a) => [loopKey(a), a]));
  const transitioning = state ? (state.transitioning ??= new Set()) : new Set<string>();
  const transitions: Promise<void>[] = [];
  // One transition per key at a time, and each key's independent of the others': one agent
  // draining a long card must not hold every other agent's edit back.
  const transition = (key: string, work: () => Promise<void>) => {
    if (transitioning.has(key)) return;
    transitioning.add(key);
    transitions.push(
      work().finally(() => {
        transitioning.delete(key);
      }),
    );
  };
  const start = (key: string, agent: BridgeAgentSecrets) => {
    try {
      registry.start(agent);
    } catch (err) {
      // One agent with a station that has gone away, or a credential that will not decrypt, must
      // not stop the other three from claiming.
      opts.onError?.(key, err instanceof Error ? err.message : String(err));
    }
  };

  // Gone, or disabled — `readBridgeRoster` filters disabled rows out, so the two arrive here
  // identically. That is deliberate: the difference matters to a human reading the list, not to
  // the supervisor, which only ever asks "should this be running".
  for (const key of running.keys()) {
    if (!wanted.has(key)) transition(key, () => registry.stop(key, "removed"));
  }

  for (const [key, agent] of wanted) {
    if (transitioning.has(key)) continue;
    const live = running.get(key);
    if (live === agent.revision) continue;
    if (live === undefined) start(key, agent);
    else
      transition(key, async () => {
        await registry.stop(key, "rebuild");
        start(key, agent);
      });
  }
  await Promise.all(transitions);
}
