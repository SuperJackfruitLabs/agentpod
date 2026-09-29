/**
 * Every `OlmMachine` this process has opened and not yet closed (issue #457).
 *
 * An open machine at exit aborts the process. Bun runs napi's env cleanup
 * hooks as it exits, napi-rs drops its Tokio runtime in one of them, and a
 * machine torn down after that reaches for the runtime (napi-2.16.17
 * `tokio_runtime.rs:114`: `Option::unwrap()` on `None`) — SIGABRT, exit 134,
 * whatever the process was doing. A machine that was closed first is safe,
 * and so is every other object the binding hands out.
 *
 * So every machine is recorded here and closed on the way out, by whichever
 * exit is happening:
 *
 * - the hub's SIGTERM handler, via `AgentCrypto.close()`;
 * - a plain `bun` process, via the `exit` listener below, which runs before
 *   the cleanup hooks (including after `process.exit()`);
 * - `bun test`, via the global `afterAll` in `tests/preload.ts`. bun test
 *   does NOT run `exit` listeners — 0 of 20 runs on Linux, Bun 1.4.2 — which
 *   is why the listener alone left CI aborting after every test had passed.
 *
 * No imports, so the test preload can load this without pulling in the
 * binding, the logger or config before a test has set its environment.
 */

/** The one method this needs; `OlmMachine.close()` is synchronous. */
interface Closeable {
  close(): void;
}

const open = new Set<Closeable>();
let listening = false;

/** Record a machine the moment it exists. */
export function trackOpenMachine(machine: Closeable): void {
  open.add(machine);
  if (listening) return;
  listening = true;
  process.on("exit", closeOpenMachines);
}

/** Close one machine, forgetting it first so a throwing close is never retried. */
export function closeTrackedMachine(machine: Closeable): void {
  open.delete(machine);
  machine.close();
}

/** Close everything still open. Synchronous, so it is safe in an `exit` listener. */
export function closeOpenMachines(): void {
  for (const machine of [...open]) {
    try {
      closeTrackedMachine(machine);
    } catch {
      // Nothing to report to on the way out, and one bad machine must not
      // keep the rest open.
    }
  }
}

/** How many machines are open now. For tests. */
export function openMachineCount(): number {
  return open.size;
}
