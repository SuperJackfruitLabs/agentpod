/**
 * Deterministic waits for test code.
 *
 * WHY THIS EXISTS
 * ---------------
 * A test that sleeps a fixed number of milliseconds and then asserts is a
 * coin toss whose odds depend on machine load. The hub had a fleet of
 * `await new Promise(r => setTimeout(r, 150))` calls standing in for "the
 * gateway has finished authenticating this node and registered it", and the
 * work being waited on is an argon2id password verify (~105 ms idle on an M-series
 * laptop, considerably more when 500 other tests are competing for the CPU)
 * plus two Postgres round trips. In a full `bun test` run those sleeps lost
 * the race often enough that every run failed a different handful of tests
 * with "Node is offline".
 *
 * The fix is to wait for the condition instead of guessing its duration:
 * poll the observable state, with a timeout that is long enough to never
 * expire on a healthy machine and an error message that says what never
 * happened. The assertions the tests make are unchanged — a node that never
 * comes online still fails, it just fails with a diagnosis.
 */

import { connectionManager } from "../../src/services/connection-manager";

/**
 * Poll `condition()` every `pollMs` until it returns something truthy, or
 * throw after `timeoutMs`. Supports async conditions.
 */
export async function pollUntil<T>(
  condition: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 5000,
  pollMs = 30
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await condition();
    if (result) return result as T;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs} ms`);
}

/**
 * Block until the gateway has registered `nodeId` in the connection manager —
 * i.e. onOpen finished `verifyNodeCredential` and `connectionManager.register`.
 * Everything that routes hub→node traffic (broker requests, station observe,
 * ACP opens) is gated on this, so tests must await it rather than sleep.
 */
export async function waitForNodeOnline(
  nodeId: string,
  timeoutMs = 10_000
): Promise<void> {
  try {
    await pollUntil(() => connectionManager.isOnline(nodeId), timeoutMs, 10);
  } catch {
    throw new Error(
      `node ${nodeId} was not registered with the connection manager within ${timeoutMs} ms ` +
        `(gateway onOpen: verifyNodeCredential → register never completed)`
    );
  }
}

/**
 * Block until the gateway has torn `nodeId` out of the connection manager,
 * which onClose does before it writes the offline status to the database.
 */
export async function waitForNodeUnregistered(
  nodeId: string,
  timeoutMs = 10_000
): Promise<void> {
  try {
    await pollUntil(() => !connectionManager.isOnline(nodeId), timeoutMs, 10);
  } catch {
    throw new Error(
      `node ${nodeId} was still registered with the connection manager after ${timeoutMs} ms ` +
        `(gateway onClose: unregister never ran)`
    );
  }
}
