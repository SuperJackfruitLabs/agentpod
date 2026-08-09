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
 * Slice 2 scope: single live session per station, no reattach after node
 * offline (recorded as a slice-3 improvement — on wire eof the session parks
 * at `waiting` and a grace timer ends it).
 */

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ClientContext,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AcpEvent,
  AcpEventType,
  AcpSessionMode,
  AcpSessionRow,
  AcpSessionStatus,
} from "@agentpod/contract";
import { db } from "../db/drizzle";
import { acpSessions, acpEvents } from "../db/schema/acp";
import { stations } from "../db/schema/stations";
import { createLogger } from "../utils/logger";
import { getStation } from "./station-registry";
import { gateCapability } from "../routes/station-writes";
import { connectionManager } from "./connection-manager";
import { recordAudit } from "./audit";
import { openAcpWire, type AcpWire } from "./acp-transport";
import * as broker from "./broker";

const log = createLogger("acp-sessions");

// How long a session survives at `waiting` after its node goes offline before
// the hub gives up (no reattach in slice 2).
let offlineGraceMs = 60_000;

/** Test hook: shrink the offline grace period. */
export function _setOfflineGraceMsForTest(ms: number): void {
  offlineGraceMs = ms;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  stationId: string;
  userId: string;
  mode: AcpSessionMode;
}

interface LiveSession {
  id: string;
  stationId: string;
  userId: string;
  nodeId: string;
  stationKey: string;
  mode: AcpSessionMode;
  status: AcpSessionStatus;
  /** Last assigned event seq (assigned synchronously; writes are chained). */
  seq: number;
  /** Serializes event/row writes so seq order matches insert order. */
  chain: Promise<void>;
  /**
   * Incremented at each prompt dispatch; the turn-completion handler captures
   * it and no-ops unless it still matches, so a stale turn's late response
   * (after cancelTurn + a new prompt) can never clobber the new turn's status.
   */
  turnEpoch: number;
  /** Parked ask-mode permission requests keyed by the request event's seq. */
  pending: Map<number, (resp: RequestPermissionResponse) => void>;
  ended: boolean;
  wire: AcpWire | null;
  connection: ClientConnection | null;
  agent: ClientContext | null;
  /** ACP protocol session id from session/new (NOT the node process id). */
  acpSessionId: string;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const liveByStation = new Map<string, LiveSession>();
const liveById = new Map<string, LiveSession>();
const subscribers = new Map<string, Set<(e: AcpEvent) => void>>();

// ─── Row mapping ─────────────────────────────────────────────────────────────

type DbRow = typeof acpSessions.$inferSelect;

function toContract(r: DbRow): AcpSessionRow {
  return {
    id: r.id,
    stationId: r.stationId,
    userId: r.userId,
    mode: r.mode as AcpSessionMode,
    status: r.status as AcpSessionStatus,
    endedReason: r.endedReason,
    createdAt: r.createdAt.toISOString(),
    lastEventAt: r.lastEventAt.toISOString(),
  };
}

// ─── Event persistence ────────────────────────────────────────────────────────

function fanOut(sessionId: string, event: AcpEvent): void {
  const set = subscribers.get(sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch (err) {
      log.error("ACP subscriber threw", { sessionId, error: String(err) });
    }
  }
}

/** Chain work onto the session's serialized write queue. */
function enqueue(live: LiveSession, fn: () => Promise<void>): Promise<void> {
  const p = live.chain.then(fn).catch((err) => {
    log.error("ACP event write failed", {
      sessionId: live.id,
      error: String(err),
    });
  });
  live.chain = p;
  return p;
}

/**
 * Persist the next event: assign seq synchronously, then (serialized) insert
 * into acp_events, bump last_event_at (+ any extra row columns), and fan out.
 */
function persistEvent(
  live: LiveSession,
  type: AcpEventType,
  payload: unknown,
  rowSet: Partial<typeof acpSessions.$inferInsert> = {}
): { seq: number; done: Promise<void> } {
  const seq = ++live.seq;
  const createdAt = new Date();
  const done = enqueue(live, async () => {
    await db.insert(acpEvents).values({
      sessionId: live.id,
      seq,
      type,
      payload: payload as object,
      createdAt,
    });
    await db
      .update(acpSessions)
      .set({ lastEventAt: createdAt, ...rowSet })
      .where(eq(acpSessions.id, live.id));
    fanOut(live.id, {
      sessionId: live.id,
      seq,
      type,
      payload,
      createdAt: createdAt.toISOString(),
    });
  });
  return { seq, done };
}

/** Status transition: update the row and persist a `state` event. */
function setStatus(
  live: LiveSession,
  status: AcpSessionStatus,
  opts: { extra?: Record<string, unknown>; endedReason?: string; force?: boolean } = {}
): { seq: number; done: Promise<void> } {
  if (live.status === status && !opts.force) {
    return { seq: live.seq, done: Promise.resolve() };
  }
  live.status = status;
  return persistEvent(
    live,
    "state",
    { status, ...(opts.extra ?? {}) },
    {
      status,
      ...(opts.endedReason !== undefined ? { endedReason: opts.endedReason } : {}),
    }
  );
}

// ─── Live-session lifecycle helpers ──────────────────────────────────────────

function requireLive(userId: string, sessionId: string): LiveSession {
  const live = liveById.get(sessionId);
  if (!live || live.userId !== userId) {
    throw new Error("Session not found or not active.");
  }
  return live;
}

/** Resolve all parked permission promises with the SDK's cancelled outcome. */
function rejectPendingPermissions(live: LiveSession): void {
  for (const [requestSeq, resolve] of live.pending) {
    resolve({ outcome: { outcome: "cancelled" } });
    persistEvent(live, "permission-answer", { requestSeq, cancelled: true });
  }
  live.pending.clear();
}

/** Terminal transition: row ended(reason) + state event, wire torn down. */
async function finalizeEnd(live: LiveSession, reason: string): Promise<void> {
  if (live.ended) return;
  live.ended = true;
  if (live.graceTimer) {
    clearTimeout(live.graceTimer);
    live.graceTimer = null;
  }
  const hadParked = live.pending.size > 0;
  rejectPendingPermissions(live);
  if (hadParked) {
    // The cancelled outcomes travel to the agent through SDK microtasks and a
    // synchronous broker send; yield one macrotask so they flush before the
    // wire is torn down (otherwise the agent may never see them).
    await new Promise((r) => setTimeout(r, 0));
  }
  const { done } = setStatus(live, "ended", {
    extra: { reason },
    endedReason: reason,
    force: true,
  });
  if (liveByStation.get(live.stationId) === live) {
    liveByStation.delete(live.stationId);
  }
  liveById.delete(live.id);
  try {
    live.connection?.close();
  } catch {
    // Connection already closed — fine.
  }
  try {
    await live.wire?.close();
  } catch {
    // Wire already closed — fine.
  }
  await done;
  if (connectionManager.isOnline(live.nodeId)) {
    // The wire's best-effort acp.close was deliverable — clear the orphan
    // marker so the node-online hook won't re-close this process later.
    await db
      .update(acpSessions)
      .set({ nodeSessionId: null })
      .where(eq(acpSessions.id, live.id));
  }
}

/**
 * Wire ended underneath us. An in-band exit reason means the agent process
 * died → end the session with it. A bare "eof" means the node went offline
 * (or the stream was torn down) → park at `waiting` and start the grace timer.
 */
async function handleWireClosed(live: LiveSession, reason: string): Promise<void> {
  try {
    // Contract note: always close() after `closed` settles (idempotent).
    await live.wire?.close();
  } catch {
    // Already closed — fine.
  }
  if (live.ended) return;
  if (reason === "eof") {
    rejectPendingPermissions(live);
    const { done } = setStatus(live, "waiting", {
      extra: { reason: "node offline" },
      force: true,
    });
    live.graceTimer = setTimeout(() => {
      void finalizeEnd(live, "Couldn't reach the node.");
    }, offlineGraceMs);
    live.graceTimer.unref?.();
    await done;
  } else {
    await finalizeEnd(live, reason);
  }
}

// ─── SDK callbacks ───────────────────────────────────────────────────────────

function handleSessionUpdate(live: LiveSession, params: SessionNotification): void {
  if (live.ended) return;
  // Every SDK sessionUpdate notification → agent-update with the raw update.
  persistEvent(live, "agent-update", params.update);
}

function handlePermissionRequest(
  live: LiveSession,
  params: RequestPermissionRequest
): Promise<RequestPermissionResponse> {
  if (live.ended) {
    return Promise.resolve({ outcome: { outcome: "cancelled" } });
  }

  const autoAllow =
    live.mode === "full-auto" ||
    (live.mode === "accept-edits" && params.toolCall.kind === "edit");

  if (autoAllow) {
    const option =
      params.options.find(
        (o) => o.kind === "allow_once" || o.kind === "allow_always"
      ) ?? params.options[0];
    const { seq: requestSeq } = persistEvent(live, "permission-request", {
      toolCall: params.toolCall,
      options: params.options,
      auto: true,
    });
    if (!option) {
      persistEvent(live, "permission-answer", { requestSeq, cancelled: true, auto: true });
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    persistEvent(live, "permission-answer", {
      requestSeq,
      optionId: option.optionId,
      auto: true,
    });
    return Promise.resolve({
      outcome: { outcome: "selected", optionId: option.optionId },
    });
  }

  // ask (or accept-edits falling through): park until answerPermission.
  const { seq: requestSeq } = persistEvent(live, "permission-request", {
    toolCall: params.toolCall,
    options: params.options,
  });
  setStatus(live, "waiting");
  return new Promise<RequestPermissionResponse>((resolve) => {
    live.pending.set(requestSeq, resolve);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createSession(
  input: CreateSessionInput
): Promise<AcpSessionRow> {
  const { stationId, userId, mode } = input;

  const station = await getStation(userId, stationId);
  if (!station) throw new Error("Station not found.");
  if (!gateCapability(station, "acp")) {
    throw new Error("This station does not support agent sessions.");
  }
  if (!connectionManager.isOnline(station.nodeId)) {
    throw new Error("Node is offline.");
  }
  if (liveByStation.has(stationId)) {
    throw new Error("An active session already exists for this agent.");
  }

  const id = `acps_${crypto.randomUUID()}`;
  const now = new Date();
  const live: LiveSession = {
    id,
    stationId,
    userId,
    nodeId: station.nodeId,
    stationKey: station.stationKey,
    mode,
    status: "starting",
    seq: 0,
    chain: Promise.resolve(),
    turnEpoch: 0,
    pending: new Map(),
    ended: false,
    wire: null,
    connection: null,
    agent: null,
    acpSessionId: "",
    graceTimer: null,
  };
  // Register before any await so a concurrent createSession is refused
  // (fresh-process semantics: single session per station in slice 2). Every
  // failure exit below MUST run finalizeEnd, which removes these entries —
  // a leaked entry would wedge the station with 409s until restart.
  liveByStation.set(stationId, live);
  liveById.set(id, live);

  try {
    await db.insert(acpSessions).values({
      id,
      stationId,
      userId,
      mode,
      status: "starting",
      endedReason: null,
      nodeSessionId: null,
      createdAt: now,
      lastEventAt: now,
    });

    const wire = await openAcpWire(station.nodeId, station.stationKey);
    live.wire = wire;

    const app = client({ name: "agentpod-hub" })
      .onNotification("session/update", ({ params }) => {
        handleSessionUpdate(live, params);
      })
      .onRequest("session/request_permission", ({ params }) =>
        handlePermissionRequest(live, params)
      );
    const connection = app.connect(ndJsonStream(wire.writable, wire.readable));
    live.connection = connection;
    live.agent = connection.agent;
    connection.closed.catch(() => {
      // Post-exit stream errors surface here; teardown runs via wire.closed.
    });
    void wire.closed.then(
      (reason) => void handleWireClosed(live, reason),
      () => void handleWireClosed(live, "wire error")
    );

    await connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "agentpod-hub", version: "0.1.0" },
    });
    const created = await connection.agent.request("session/new", {
      // The SDK requires an absolute cwd; the station workspace is the
      // natural one, "/" the fallback for workspace-less stations.
      cwd: station.workspacePath ?? "/",
      mcpServers: [],
    });
    live.acpSessionId = created.sessionId;

    await db
      .update(acpSessions)
      .set({ nodeSessionId: wire.nodeSessionId })
      .where(eq(acpSessions.id, id));
    await setStatus(live, "idle").done;

    const rows = await db
      .select()
      .from(acpSessions)
      .where(eq(acpSessions.id, id));
    return toContract(rows[0]!);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    persistEvent(live, "error", { message: reason });
    await finalizeEnd(live, reason);
    throw err;
  }
}

export async function listSessions(
  userId: string,
  stationId: string
): Promise<AcpSessionRow[]> {
  const rows = await db
    .select()
    .from(acpSessions)
    .where(
      and(eq(acpSessions.userId, userId), eq(acpSessions.stationId, stationId))
    );
  return rows.map(toContract);
}

export async function getSession(
  userId: string,
  sessionId: string
): Promise<AcpSessionRow | null> {
  const rows = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)));
  return rows[0] ? toContract(rows[0]) : null;
}

export async function promptSession(
  userId: string,
  sessionId: string,
  text: string
): Promise<void> {
  const live = requireLive(userId, sessionId);
  if (live.status !== "idle") {
    throw new Error("Session is busy — wait for the current turn to finish.");
  }
  const agent = live.agent;
  if (!agent) throw new Error("Session is still starting.");

  const { done: promptWritten } = persistEvent(live, "user-prompt", { text });
  const { done: statusWritten } = setStatus(live, "working");
  await Promise.all([promptWritten, statusWritten]);

  // Audit the action, never the prompt text. An audit failure must not strand
  // the session at `working`: revert to idle with an error event and rethrow.
  let audit: Awaited<ReturnType<typeof recordAudit>>;
  try {
    audit = await recordAudit(db, {
      userId,
      nodeId: live.nodeId,
      stationKey: live.stationKey,
      verb: "acp.prompt",
      params: { chars: text.length },
    });
  } catch (err) {
    persistEvent(live, "error", {
      message: "Couldn't record the audit entry — prompt aborted.",
    });
    await setStatus(live, "idle").done;
    throw err;
  }

  // Stale-turn guard: only the completion of the CURRENT turn may transition
  // status (a late response from a cancelled turn must not reset a new one).
  live.turnEpoch += 1;
  const epoch = live.turnEpoch;
  const isCurrentTurn = () =>
    !live.ended && live.turnEpoch === epoch && live.status === "working";

  // The turn runs in the background; its completion restores idle. Callers
  // observe progress via subscribe()/acp_events, not this promise.
  agent
    .request("session/prompt", {
      sessionId: live.acpSessionId,
      prompt: [{ type: "text", text }],
    })
    .then(async () => {
      await audit.done("ok");
      if (isCurrentTurn()) {
        await setStatus(live, "idle").done;
      }
    })
    .catch(async (err) => {
      await audit
        .done("error", err instanceof Error ? err.message : String(err))
        .catch(() => {});
      // Wire-level failures transition the session via handleWireClosed; only
      // recover to idle when this turn is still the live one.
      if (isCurrentTurn()) {
        await setStatus(live, "idle").done;
      }
    });
}

export async function cancelTurn(
  userId: string,
  sessionId: string
): Promise<void> {
  const live = requireLive(userId, sessionId);
  if (live.status !== "working" && live.status !== "waiting") return;
  const agent = live.agent;
  rejectPendingPermissions(live);
  if (agent) {
    await agent
      .notify("session/cancel", { sessionId: live.acpSessionId })
      .catch(() => {
        // Errored writable after wire close — teardown handles the session.
      });
  }
  await setStatus(live, "idle").done;
}

export async function answerPermission(
  userId: string,
  sessionId: string,
  requestSeq: number,
  optionId: string
): Promise<void> {
  const live = requireLive(userId, sessionId);
  const resolve = live.pending.get(requestSeq);
  if (!resolve) throw new Error("No pending permission request.");
  live.pending.delete(requestSeq);
  const { done: answerWritten } = persistEvent(live, "permission-answer", {
    requestSeq,
    optionId,
  });
  const { done: statusWritten } = setStatus(live, "working");
  resolve({ outcome: { outcome: "selected", optionId } });
  await Promise.all([answerWritten, statusWritten]);
}

export async function setMode(
  userId: string,
  sessionId: string,
  mode: AcpSessionMode
): Promise<void> {
  const live = liveById.get(sessionId);
  if (live && live.userId !== userId) throw new Error("Session not found.");
  const rows = await db
    .update(acpSessions)
    .set({ mode })
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)))
    .returning({ id: acpSessions.id });
  if (rows.length === 0) throw new Error("Session not found.");
  if (live) live.mode = mode;
}

export async function endSession(
  userId: string,
  sessionId: string,
  reason: string
): Promise<void> {
  const live = liveById.get(sessionId);
  if (live) {
    if (live.userId !== userId) throw new Error("Session not found.");
    await finalizeEnd(live, reason);
    return;
  }
  // Not live (e.g. found via a stale row): mark the row ended if owned.
  const rows = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)));
  if (!rows[0]) throw new Error("Session not found.");
  if (rows[0].status === "ended") return;
  await appendEndedState(sessionId, reason);
}

/**
 * Append a state-ended event (seq = MAX(seq)+1) and mark a NON-LIVE row ended.
 * Live sessions go through finalizeEnd instead (in-memory seq counter).
 */
async function appendEndedState(sessionId: string, reason: string): Promise<void> {
  const [agg] = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${acpEvents.seq}), 0)` })
    .from(acpEvents)
    .where(eq(acpEvents.sessionId, sessionId));
  const seq = Number(agg?.maxSeq ?? 0) + 1;
  const createdAt = new Date();
  const payload = { status: "ended", reason };
  await db.insert(acpEvents).values({
    sessionId,
    seq,
    type: "state",
    payload,
    createdAt,
  });
  await db
    .update(acpSessions)
    .set({ status: "ended", endedReason: reason, lastEventAt: createdAt })
    .where(eq(acpSessions.id, sessionId));
  fanOut(sessionId, {
    sessionId,
    seq,
    type: "state",
    payload,
    createdAt: createdAt.toISOString(),
  });
}

/** Subscribe to live events; replay is the caller's job (read acp_events). */
export function subscribe(
  sessionId: string,
  fn: (e: AcpEvent) => void
): () => void {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const current = subscribers.get(sessionId);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) subscribers.delete(sessionId);
  };
}

/**
 * Boot reconciliation: mark all non-ended sessions ended("hub restarted");
 * best-effort acp.close each orphaned nodeSessionId whose node is online at
 * boot (log the rest). Call from index.ts boot after initDatabase.
 */
export async function reconcileOnBoot(): Promise<void> {
  const stale = await db
    .select()
    .from(acpSessions)
    .where(ne(acpSessions.status, "ended"));

  for (const row of stale) {
    await appendEndedState(row.id, "hub restarted");

    if (!row.nodeSessionId) continue;
    // stationId deliberately has no FK — the station may be gone.
    const stationRows = await db
      .select({ nodeId: stations.nodeId })
      .from(stations)
      .where(eq(stations.id, row.stationId));
    const nodeId = stationRows[0]?.nodeId;
    if (nodeId && connectionManager.isOnline(nodeId)) {
      // Best-effort: broker.request never rejects; result is ignored.
      void broker.request(nodeId, "acp.close", {
        sessionId: row.nodeSessionId,
      });
      await db
        .update(acpSessions)
        .set({ nodeSessionId: null })
        .where(eq(acpSessions.id, row.id));
    } else {
      // Kept as an orphan marker (non-null node_session_id on an ended row):
      // the node-online hook below closes it when the node next connects.
      log.info("ACP reconcile: orphaned agent process awaits node reconnect", {
        sessionId: row.id,
        nodeSessionId: row.nodeSessionId,
        stationId: row.stationId,
      });
    }
  }

  if (stale.length > 0) {
    log.info(`ACP reconcile: ended ${stale.length} stale session(s) from before restart`);
  }
}

// ─── Orphaned-process cleanup on node reconnect ──────────────────────────────

/**
 * Close agent processes orphaned by a hub restart once their node is back.
 *
 * Orphan marker: an ENDED session row that still carries node_session_id
 * (live/normal ends clear it when the close was deliverable). Fires one
 * best-effort acp.close per orphan and clears the marker so it's once-only.
 * Never touches non-ended rows, so live sessions are safe.
 */
async function closeOrphanedProcesses(nodeId: string): Promise<void> {
  const orphans = await db
    .select({
      id: acpSessions.id,
      nodeSessionId: acpSessions.nodeSessionId,
    })
    .from(acpSessions)
    .innerJoin(stations, eq(stations.id, acpSessions.stationId))
    .where(
      and(
        eq(stations.nodeId, nodeId),
        eq(acpSessions.status, "ended"),
        isNotNull(acpSessions.nodeSessionId)
      )
    );
  for (const orphan of orphans) {
    // Best-effort: broker.request never rejects; result is ignored.
    void broker.request(nodeId, "acp.close", {
      sessionId: orphan.nodeSessionId!,
    });
    await db
      .update(acpSessions)
      .set({ nodeSessionId: null })
      .where(eq(acpSessions.id, orphan.id));
    log.info("ACP orphan cleanup: closed agent process on reconnected node", {
      sessionId: orphan.id,
      nodeId,
      nodeSessionId: orphan.nodeSessionId,
    });
  }
}

// In production no node is connected when reconcileOnBoot runs, so the
// boot-time close path never fires — the real cleanup happens here, when
// each affected node next connects.
connectionManager.onNodeOnline((nodeId) => {
  closeOrphanedProcesses(nodeId).catch((err) => {
    log.error("ACP orphan cleanup failed", { nodeId, error: String(err) });
  });
});
