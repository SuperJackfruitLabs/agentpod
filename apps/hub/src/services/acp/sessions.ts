/**
 * ACP session service — hub-owned agent sessions over the ACP wire.
 *
 * The hub is the ACP *client*; the agent process on the node is the ACP
 * *agent*. Each live session binds the official ACP TypeScript SDK
 * (fluent `client()` app + `ndJsonStream`) onto the byte streams from
 * `openAcpWire` (acp-transport.ts) and owns:
 *
 *   - the session row in `acp_sessions` (status machine:
 *     starting → idle ⇄ working ⇄ waiting → ended),
 *   - the append-only transcript in `acp_events` (per-session `seq`,
 *     assigned in memory, writes serialized per session),
 *   - permission-mode enforcement (ask / accept-edits / full-auto) for the
 *     agent's `session/request_permission` callbacks,
 *   - live fan-out to subscribers (replay is the caller's job — read
 *     acp_events).
 *
 * A station can host SEVERAL live sessions at once (slice 4b): each one opens
 * its own ACP wire with the hub session id as the `instance`, so the node keys
 * a separate agent process per session. Nodes that predate the instance
 * discriminator hand the same process back for every instance — detectable
 * only from `AcpWire.instanceEchoed` — and those stations stay
 * one-session-at-a-time (see createSession).
 *
 * No reattach after the node goes offline: on wire eof the session parks at
 * `waiting` and a grace timer ends it.
 *
 * This file is the service's surface: it re-exports what the rest of the hub (through
 * `index.ts`) and the tests use, from the files that hold each concern, and registers the
 * node-online hook at load, as it always has:
 *
 *   session-state   the live sessions and the input a session opens from
 *   timing          deadlines and the per-station / per-session locks
 *   events          the event log, status transitions, subscribers
 *   rows            session rows, titles, the list, the stored transcript
 *   gates           readiness, the one-execution refusal, node capabilities
 *   handshake       the ACP client, initialize and session/new|load
 *   updates         the agent's session/update notifications
 *   permissions     permission modes and answers, setMode
 *   end             the one terminal transition
 *   salaam-authority  renewal, the authority watch, idle end
 *   turn            dispatching a prompt and settling its turn
 *   plugin-reports  a harness plugin's account of a failed turn
 *   recovery        wire loss, re-attach, Salaam restore and reconnect
 *   open, prompt, cancel, ending, busy, boot   the operations themselves
 */

import { connectionManager } from "../broker";
import { closeOrphanedProcesses } from "./boot";
import { log } from "./log";
import { recoverSalaamForNode } from "./recovery";

export { closeOrphanedProcesses, reconcileOnBoot } from "./boot";
export { SESSION_BUSY_MESSAGE, sessionIsBusy, whenIdle } from "./busy";
export { _setSalaamCancelBeforeNotifyForTest, cancelTurn } from "./cancel";
export { endSession, endSessionAsWorkspaceAdmin } from "./ending";
export { _subscriberCountForTest, subscribe } from "./events";
export {
  STATION_BUSY_REASON,
  SalaamStationBusy,
  interactiveWorkspaceAdmin,
  isSalaamStationBusy,
  stationReadiness,
  type StationReadiness,
} from "./gates";
export { sessionHasLibraryTools } from "./handshake";
export { SessionNotResumable, createSession, isSessionNotResumable, resumeSession } from "./open";
export { answerPermission, cancelPermission, setMode } from "./permissions";
export type { PermissionAnswerer } from "./permissions";
export { reportTurnError, type TurnErrorReportOutcome } from "./plugin-reports";
export { promptSession } from "./prompt";
export {
  _setSalaamRestoreBeforeLockForTest,
  ensureSalaamLive,
  recoverSalaamForNode,
} from "./recovery";
export {
  clampSessionLimit,
  deriveSessionTitle,
  getSession,
  listSessions,
  readEvents,
  type ListSessionsOptions,
} from "./rows";
export {
  SALAAM_IDLE_END_DEFAULT_MINUTES,
  endIdleSalaamSessions,
  idleEndDue,
  idleEndReason,
  renewExecution,
  salaamIdleEndMs,
  type IdleCandidate,
} from "./salaam-authority";
export { _forgetLiveForTest, _isLiveForTest, type CreateSessionInput } from "./session-state";
export {
  _setHandshakeTimeoutMsForTest,
  _setOfflineGraceMsForTest,
  _setOpenDbTimeoutMsForTest,
  _setTurnErrorGraceMsForTest,
} from "./timing";

// In production no node is connected when reconcileOnBoot runs, so the
// boot-time close path never fires — the real cleanup happens here, when
// each affected node next connects.
connectionManager.onNodeOnline((nodeId) => {
  void recoverSalaamForNode(nodeId).catch((err) =>
    log.error("Salaam recovery failed", { nodeId, error: String(err) }),
  );
  closeOrphanedProcesses(nodeId).catch((err) => {
    log.error("ACP orphan cleanup failed", { nodeId, error: String(err) });
  });
});
