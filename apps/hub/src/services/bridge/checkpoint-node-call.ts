/**
 * How long the Hub waits on one coordinator call to the selected node.
 *
 * A wait that ends is never a failure: the broker sends no cancel, so the node carries on, and the
 * attempt stays parked on its phase until a later `status` reads what the node did. These bounds
 * only decide how long one bridge cycle holds its agent while it waits.
 *
 * The node asks the Hub for a current decision before and after each effect, and waits up to
 * `NODE_CURRENT_DEADLINE_MS` for each (apps/node-agent/internal/benchbridge/current.go).
 * - `status` makes one current check, then reads the node's journal and the producer's receipts.
 * - `prepare` makes two current checks, reads the bench, and creates, leases and checkpoints it.
 * - `execute` launches a task that may run for its whole `timeout_seconds`. No bound can fit that,
 *   so the Hub waits for a short run only; a longer one is read later with `status`.
 */
export const NODE_CURRENT_DEADLINE_MS = 20_000;
export const NODE_CALL_TIMEOUT_MS = {
  ready: 5_000,
  status: 60_000,
  prepare: 120_000,
  execute: 60_000,
} as const;

export function nodeCallTimeoutMs(operation: keyof typeof NODE_CALL_TIMEOUT_MS): number {
  return NODE_CALL_TIMEOUT_MS[operation];
}
