/**
 * One claim, worked start to finish.
 *
 *   claim → check for prior output → read the run's context → assemble the
 *   prompt → open an ACP session → coalesce the transcript into activities →
 *   report → close.
 *
 * Three things here exist because the spike measured them and could not fix
 * them in throwaway code:
 *
 * 1. **A 409 ends the ACP session.** superpipeline fences its own state — the
 *    reclaim experiment came back with `leaseEpoch: 2` and the old run locked
 *    out of every write. But nothing fences the *machine*: the original harness
 *    kept executing with no idea its lease had been revoked, and in a task that
 *    outlives the 15-minute reclaim two harnesses would be writing the same
 *    directory while superpipeline correctly ignored one of them. The lease is
 *    learned to be stale on a verb; that is where the session is ended.
 *
 * 2. **A 403 is not a 409.** `NOT_RUN_OWNER` means this run belongs to another
 *    agent — understood, permanently refused, and a bug in the caller.
 *    Retrying repeats the hijack, so this run is never touched again and the
 *    agent's loop stops rather than claiming into the same fault.
 *
 * 3. **The prior-output check comes before the work.** Reclaim is at-least-once:
 *    a run that finished and never reported comes back. The work is not
 *    idempotent — it edited a workspace — but the *report* is, so a recorded
 *    handoff is replayed onto the new run and the harness is not started.
 *
 * A fourth was measured on the live hub, on the bridge's very first cycle: it
 * claimed a card two seconds after a restart, before the node-agents had
 * reconnected, and the session open threw "Node is offline.". The card sat in
 * `working` with a delegate assigned, held by a run that would never do
 * anything, until the board's 15-minute reclaim. Two rules came out of it:
 *
 * 4. **Nothing is claimed until the station can run it**, so the window is not
 *    entered in the first place; and **a claim that never started is handed
 *    back**, so the window that remains costs seconds instead of 15 minutes.
 *    "Never started" is exact: no ACP session was opened, so nothing can have
 *    touched the workspace and `release` is unambiguously safe. Once a session
 *    exists the answer changes — see `failStarted`.
 *
 * A fifth came from running a real card and then being unable to say what had
 * happened. The hub could count what arrived — 142 rows in `acp_events`, 135 of
 * them `agent-update` — and had no way at all to count what it posted out.
 *
 * 5. **A dispatch counts both ends of its own transcript.** Coalescing is the
 *    reason 1,051 Hermes events do not become 1,051 HTTP POSTs, and until this
 *    it could have been completely broken in production with nothing to show
 *    it. Two integers on the ledger row and one log line per worked card — see
 *    `summarise`, which is also where the bound on that lives.
 *
 * A sixth arrived the same way, on the next real card. The agent wrote two
 * files, asked permission to run the tests, and the run ended `abandoned` with
 * "the agent asked for permission, which the board cannot answer" — partial work
 * left in the workspace, card parked. `accept-edits` auto-approves file writes
 * and NOT command execution, so every card whose work involved running
 * something died exactly there.
 *
 * 6. **A permission request is a question, and the bridge waits for the
 *    answer.** superpipeline PR #36 built the return path, so the request becomes an
 *    elicitation carrying its options, the bridge heartbeats while a human
 *    decides, and the answer is delivered to the harness on the same lease —
 *    the run never lets go of the card to ask. The wait is bounded by policy
 *    (`permissionWaitMs`), not by the lease, because a heartbeating lease is
 *    never reclaimed. See `askTheHuman`.
 *
 * This file is the dispatch's surface: it re-exports what the loop, salaam-dispatch and the tests
 * use, from the files that hold each concern:
 *
 *   dispatch-types      the ACP port, the dependencies, the result, the defaults
 *   dispatch-readiness  the bounded readiness probe
 *   dispatch-run        runOnce: the strict check, the probe, the claim
 *   dispatch-work       after a claim: the session open, the turn, settling its end
 *   dispatch-turn       the turn's state, board queue, subscriber, heartbeat and questions
 *   dispatch-exits      the summary, replay, hand-back, failure after start, lost lease
 *   dispatch-prompt     the card prompt and the board tools
 */

export { READINESS_PROBE_TIMEOUT_MS } from "./dispatch-readiness";
export { runOnce } from "./dispatch-run";
export { assemblePrompt } from "./dispatch-prompt";
export type { AcpPort, DispatchDeps, DispatchResult, DispatchStatus } from "./dispatch-types";
