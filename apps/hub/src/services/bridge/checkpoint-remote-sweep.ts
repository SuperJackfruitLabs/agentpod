/**
 * The detach sweep: a remote bench stage's station whose detach never confirmed.
 *
 * Every way a remote attempt ends asks the agent's node to restore the station's own terminal
 * (`bench.remote.detach`): the finish, a failure, a run the board ended, a superseded profile. A
 * detach whose node was offline, timed out or refused leaves the attempt ended but its station
 * possibly still pointed at a released bench, so the station stays busy (`stationBenchBusy`) and
 * takes no board work. This sweep, on the bench clearing's timer, asks again for every ended attempt
 * that may still be attached (`mayBeAttached`: an attach was sent, whether or not its reply came, and
 * no detach is confirmed). A confirmed detach is recorded, which frees the station. Anything else
 * only logs, and the next sweep asks again. It never touches an attempt still in progress, the bench
 * host's node or the board.
 */
import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { checkpointDispatches } from "../../db/schema/checkpoint-dispatch";
import { createLogger } from "../../utils/logger";
import { request as nodeRequest } from "../broker";
import { CHECKPOINT_TERMINAL_PHASES, checkedCheckpointAttempt, recordCheckpointRemoteDetached,
  type RetainedCheckpointAttempt } from "./checkpoint-ledger";
import { isRemoteProfile } from "./checkpoint-profile";
import { noteCheckpoint } from "./checkpoint-log";
import { detachAgent, type RemoteCallDeps } from "./checkpoint-remote-calls";
import { canonicalRemoteState, mayBeAttached, parseRemoteState } from "./checkpoint-remote-state";

const log = createLogger("bridge-checkpoint");

export interface RemoteDetachDeps extends Pick<RemoteCallDeps, "request"> {
  /** Ended remote attempts whose state does not record a confirmed detach. */
  attempts(): Promise<RetainedCheckpointAttempt[]>;
  /** Store the state with the detach confirmed. False when the row moved on meanwhile. */
  record(attempt: RetainedCheckpointAttempt, remote: string): Promise<boolean>;
}

/** One sweep: a detach for every ended attempt that may still be attached. Returns how many were confirmed. Never throws. */
export async function sweepRemoteDetach(deps: RemoteDetachDeps = remoteDetachDeps()): Promise<number> {
  let attempts: RetainedCheckpointAttempt[];
  try { attempts = await deps.attempts(); } catch (error) {
    noteCheckpoint("remote-sweep", "remote.sweep.rows", {}, error);
    return 0;
  }
  let detached = 0;
  for (const attempt of attempts) {
    const meta = { tenantId: attempt.row.tenantId, attemptId: attempt.row.attemptId, phase: attempt.row.phase };
    try {
      const executor = attempt.profile.executor;
      // Only an ended attempt: one in progress detaches on its own way out.
      if (!CHECKPOINT_TERMINAL_PHASES.has(attempt.row.phase) || !isRemoteProfile(attempt.profile) || !executor) continue;
      const state = parseRemoteState(attempt.row.remote);
      if (!state || !mayBeAttached(state)) continue;
      const reply = await detachAgent(executor.nodeId, { stationId: executor.stationId, attemptId: attempt.row.attemptId }, deps);
      if ("refused" in reply) { noteCheckpoint("remote-sweep", `remote.detach.${reply.refused.code}`, meta); continue; }
      if (!await deps.record(attempt, canonicalRemoteState({ ...state, detached: true }))) {
        noteCheckpoint("remote-sweep", "remote.detach.raced", meta);
        continue;
      }
      detached++;
      log.info("a remote bench stage's station was detached by the sweep; it is free for board work", { ...meta, nodeId: executor.nodeId,
        stationId: executor.stationId });
    } catch (error) {
      noteCheckpoint("remote-sweep", "remote.detach", meta, error);
    }
  }
  return detached;
}

/** Ended attempts whose remote state says not detached. A row that does not pass its checks is named and skipped. */
async function undetachedAttempts(): Promise<RetainedCheckpointAttempt[]> {
  const rows = await db.select().from(checkpointDispatches).where(and(inArray(checkpointDispatches.phase, [...CHECKPOINT_TERMINAL_PHASES]),
    isNotNull(checkpointDispatches.remote), sql`(${checkpointDispatches.remote}::jsonb ->> 'detached') = 'false'`));
  const attempts: RetainedCheckpointAttempt[] = [];
  for (const row of rows) {
    try { attempts.push(checkedCheckpointAttempt(row)); }
    catch (error) { noteCheckpoint("remote-sweep", "remote.sweep.row", { tenantId: row.tenantId, attemptId: row.attemptId }, error); }
  }
  return attempts;
}

export function remoteDetachDeps(overrides: Partial<RemoteDetachDeps> = {}): RemoteDetachDeps {
  return { attempts: undetachedAttempts, request: nodeRequest, record: recordCheckpointRemoteDetached, ...overrides };
}
