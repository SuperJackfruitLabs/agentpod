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
 */

import { and, asc, desc, eq, gt, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
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
import { resolveTenantForUser } from "../auth/tenant";
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

// Deadline for each ACP handshake request (initialize, session/new). An agent
// process that spawns but never speaks ACP (interactive-prompt/TTY wedge —
// the class Hermes hit in dogfooding) must not leave createSession pending
// forever: the live-map entry is registered before the handshake, so a hung
// await would 409-lock the station until hub restart.
let handshakeTimeoutMs = 30_000;

/** Test hook: shrink the handshake deadline. */
export function _setHandshakeTimeoutMsForTest(ms: number): void {
  handshakeTimeoutMs = ms;
}

const HANDSHAKE_TIMEOUT_MESSAGE =
  "Couldn't start the agent process — the agent didn't respond (handshake timed out).";

// Deadline for each DB step of the open phase. Postgres has no statement
// timeout here (and must not get one — boot migrations share the client), so a
// blocked query would otherwise hang openSession forever: its live-map entry is
// already registered, its catch never runs, and layer 1 would refuse every
// later create for that station until hub restart.
let openDbTimeoutMs = 10_000;

/** Test hook: shrink the per-step deadline for the open phase's DB writes. */
export function _setOpenDbTimeoutMsForTest(ms: number): void {
  openDbTimeoutMs = ms;
}

const OPEN_DB_TIMEOUT_MESSAGE =
  "Couldn't start the agent process — the database didn't respond (write timed out).";

/**
 * Bound one DB step of the open phase so a stall REJECTS into openSession's
 * catch (error event → finalizeEnd → live-map cleanup) instead of hanging.
 * `step` names the culprit in the log; the thrown copy stays stable.
 */
function boundedDb<T>(promise: Promise<T>, step: string): Promise<T> {
  return withDeadline(promise, openDbTimeoutMs, OPEN_DB_TIMEOUT_MESSAGE).catch(
    (err: unknown) => {
      if (err instanceof Error && err.message === OPEN_DB_TIMEOUT_MESSAGE) {
        log.error("ACP open: database step timed out", { step });
      }
      throw err;
    }
  );
}

/**
 * Reject with `message` if `promise` doesn't settle within `ms`.
 *
 * On timeout the underlying promise is left to settle later (the SDK rejects
 * it when the connection closes) — its eventual rejection is swallowed so it
 * never becomes an unhandled rejection.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      promise.catch(() => {});
      reject(new Error(message));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  stationId: string;
  userId: string;
  mode: AcpSessionMode;
}

interface LiveSession {
  id: string;
  /** The session's tenant, carried so every event write inherits it. */
  tenantId: string;
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
  /** Node process id from acp.open; null until the wire is open. */
  nodeSessionId: string | null;
  /**
   * Did the node echo our instance on acp.open? null until the wire is open.
   * `true` is the ONLY evidence that this node keys agent processes on
   * (station key, instance) and can therefore host a concurrent session.
   */
  instanceEchoed: boolean | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

/** Live sessions per station — one-to-many since slice 4b. */
const liveByStation = new Map<string, Set<LiveSession>>();
const liveById = new Map<string, LiveSession>();
const subscribers = new Map<string, Set<(e: AcpEvent) => void>>();

/** Verbatim copy the routes map to 409 — do not reword (tests pin it). */
const ACTIVE_SESSION_MESSAGE = "An active session already exists for this agent.";

function addLive(live: LiveSession): void {
  let set = liveByStation.get(live.stationId);
  if (!set) {
    set = new Set();
    liveByStation.set(live.stationId, set);
  }
  set.add(live);
  liveById.set(live.id, live);
}

/** Identity-guarded removal; the station key drops when its last one goes. */
function removeLive(live: LiveSession): void {
  const set = liveByStation.get(live.stationId);
  if (set) {
    set.delete(live);
    if (set.size === 0) liveByStation.delete(live.stationId);
  }
  if (liveById.get(live.id) === live) liveById.delete(live.id);
}

/** Live sessions on the station other than `self`. */
function otherLive(stationId: string, self: LiveSession): LiveSession[] {
  const set = liveByStation.get(stationId);
  if (!set) return [];
  return [...set].filter((s) => s !== self);
}

/**
 * Is this node process id currently held by a LIVE session? Guards the
 * orphan-cleanup paths: an ended row may carry the same node_session_id as a
 * live session (a pre-instance node reuses one process per station key), and
 * closing it would kill the live session's agent.
 */
function isNodeSessionIdLive(nodeId: string, nodeSessionId: string): boolean {
  for (const live of liveById.values()) {
    if (live.nodeId === nodeId && live.nodeSessionId === nodeSessionId) {
      return true;
    }
  }
  return false;
}

// ─── Row mapping ─────────────────────────────────────────────────────────────

type DbRow = typeof acpSessions.$inferSelect;

/** Columns a row write may set alongside the ones persistEvent owns. */
type SessionRowPatch = PgUpdateSetSource<typeof acpSessions>;

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
    // Slice 4c (history): the console's session list renders the title and
    // sizes the transcript from lastSeq — a row that omitted them would leave
    // every session labelled "Session" no matter what was persisted.
    title: r.title,
    lastSeq: r.lastSeq,
  };
}

// ─── Session titles ───────────────────────────────────────────────────────────

/**
 * Stored title length, counted in CODE POINTS. Truncation is stored as-is with
 * NO ellipsis: how a clipped title is presented (…, fade, tooltip) is the
 * console's choice, and baking a glyph in here would corrupt the data for every
 * other reader.
 */
const TITLE_MAX_CHARS = 80;

/**
 * The title a prompt would give a session: trimmed, clipped to 80 code points.
 * Whitespace-only prompts name nothing (null) — the next real prompt titles
 * the session instead.
 *
 * The cut is code-point-safe (Array.from, not slice): `"a".repeat(79) + "😀"`
 * has 81 UTF-16 code units, and a plain `slice(0, 80)` would keep the emoji's
 * HIGH SURROGATE only. That lone surrogate is not valid UTF-8, so postgres.js
 * drops it on the way in — the emoji vanishes and the stored title is 79 chars,
 * silently, with no error anywhere. Code points, not grapheme clusters
 * (Intl.Segmenter): the contract is a character budget, and a grapheme-limited
 * cut could store far more than 80 characters. A multi-code-point emoji
 * sequence (ZWJ family, flag) can still be split at the boundary, but every
 * piece stays well-formed text — which is the invariant that matters here.
 */
export function deriveSessionTitle(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const points = Array.from(trimmed);
  if (points.length <= TITLE_MAX_CHARS) return trimmed;
  return points.slice(0, TITLE_MAX_CHARS).join("");
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
 * into acp_events, bump last_event_at + last_seq (+ any extra row columns), and
 * fan out.
 *
 * last_seq rides along in the SAME update as last_event_at — a second round
 * trip would double every event's write cost and could be observed half-applied
 * (a row whose activity moved but whose transcript size didn't). Plain
 * assignment is safe because the writes are serialized per session (enqueue)
 * in seq order, so the last write always carries the highest seq.
 */
function persistEvent(
  live: LiveSession,
  type: AcpEventType,
  payload: unknown,
  rowSet: SessionRowPatch = {}
): { seq: number; done: Promise<void> } {
  const seq = ++live.seq;
  const createdAt = new Date();
  const done = enqueue(live, async () => {
    await db.insert(acpEvents).values({
      sessionId: live.id,
      // The session's tenant, not a re-resolved one. acp_events carries a
      // composite FK to (acp_sessions.id, tenant_id), so an event can only ever
      // sit in its session's tenant — copying it from `live` is the copy the
      // database checks.
      tenantId: live.tenantId,
      seq,
      type,
      payload: payload as object,
      createdAt,
    });
    await db
      .update(acpSessions)
      .set({ lastEventAt: createdAt, lastSeq: seq, ...rowSet })
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
  removeLive(live);
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

/**
 * Serializes the open phase per station — the other half of layer 1.
 *
 * Layer 1 refuses on `instanceEchoed !== true`, and a session's verdict is null
 * until ITS acp.open completes. So without this lock two simultaneous creates on
 * a perfectly modern station would race: the second would see the first's null
 * verdict and 409 a session that is entirely legal. Queueing the open phase
 * means the second create reads a settled verdict and only refuses for real.
 *
 * The strict check and this lock are a PAIR, and dismantling either re-opens
 * two-hub-sessions-on-one-agent-process for pre-instance nodes:
 *   - relax layer 1 to `=== false` and two concurrent opens on an old node both
 *     pass (neither has a verdict yet) and land on the same shared process,
 *   - drop the lock and layer 1 has to stay strict, which spuriously 409s
 *     legitimate concurrent creates.
 * Layer 2 (post-open) is the last resort if both are somehow bypassed.
 */
const openLocks = new Map<string, Promise<unknown>>();

/**
 * Backstop ceiling on one queued open, so a stalled open can never park every
 * later create for that station behind it. Every step INSIDE the open phase has
 * its own deadline (two handshake requests, four DB steps), and this ceiling is
 * their sum plus slack — so a single stalled step always trips its own,
 * attributable deadline first and this one only catches something unbounded
 * that slipped in.
 */
const OPEN_PHASE_SLACK_MS = 5_000;
const OPEN_PHASE_DB_STEPS = 4;
const OPEN_PHASE_TIMEOUT_MESSAGE =
  "Couldn't start the agent process — it didn't finish starting in time.";

function openPhaseTimeoutMs(): number {
  return (
    handshakeTimeoutMs * 2 +
    openDbTimeoutMs * OPEN_PHASE_DB_STEPS +
    OPEN_PHASE_SLACK_MS
  );
}

function withStationOpenLock<T>(
  stationId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = openLocks.get(stationId);
  const run = (async () => {
    if (prev) await prev.catch(() => {});
    return withDeadline(fn(), openPhaseTimeoutMs(), OPEN_PHASE_TIMEOUT_MESSAGE);
  })();
  openLocks.set(stationId, run);
  void run.then(
    () => {},
    () => {}
  ).then(() => {
    if (openLocks.get(stationId) === run) openLocks.delete(stationId);
  });
  return run;
}

export async function createSession(
  input: CreateSessionInput
): Promise<AcpSessionRow> {
  const { stationId, userId } = input;

  // Fail fast on the obvious gates before queueing (openSession re-checks them
  // under the lock, where the answers are current).
  const station = await getStation(userId, stationId);
  if (!station) throw new Error("Station not found.");
  if (!gateCapability(station, "acp")) {
    throw new Error("This station does not support agent sessions.");
  }
  if (!connectionManager.isOnline(station.nodeId)) {
    throw new Error("Node is offline.");
  }

  return withStationOpenLock(stationId, () => openSession(input));
}

async function openSession(input: CreateSessionInput): Promise<AcpSessionRow> {
  const { stationId, userId, mode } = input;

  // Re-read the station and its node's presence: a queued open can start a
  // minute after createSession was called, by which time the station may have
  // been re-adopted onto another node, lost the capability, or gone offline.
  // The open must target CURRENT routing, never the snapshot from the queue.
  const station = await getStation(userId, stationId);
  if (!station) throw new Error("Station not found.");
  if (!gateCapability(station, "acp")) {
    throw new Error("This station does not support agent sessions.");
  }
  if (!connectionManager.isOnline(station.nodeId)) {
    throw new Error("Node is offline.");
  }
  const { nodeId, stationKey, workspacePath } = station;

  // ── Compatibility layer 1 (pre-open) ───────────────────────────────────────
  // A concurrent session is only safe when the node keys its agent processes on
  // (station key, instance). The one signal for that is a live sibling whose
  // acp.open echoed the instance back; anything else (an old node, or a sibling
  // that never got that far) means one shared process — refuse. Runs with no
  // await between it and addLive below, and under the station open lock, so no
  // second open can slip past it (see withStationOpenLock).
  for (const sibling of liveByStation.get(stationId) ?? []) {
    if (sibling.instanceEchoed !== true) {
      throw new Error(ACTIVE_SESSION_MESSAGE);
    }
  }

  const id = `acps_${crypto.randomUUID()}`;
  const now = new Date();
  // Resolved once, here, and carried on the live session: every event this
  // session ever writes inherits it, so a transcript cannot end up split across
  // tenants by a later re-resolution.
  const tenantId = await resolveTenantForUser(userId);
  const live: LiveSession = {
    id,
    tenantId,
    stationId,
    userId,
    nodeId,
    stationKey,
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
    nodeSessionId: null,
    instanceEchoed: null,
    graceTimer: null,
  };
  // Register before any await so siblings (and the layers above) can see this
  // session while it is starting. Every failure exit below MUST run
  // finalizeEnd, which removes these entries — a leaked entry would wedge the
  // station with 409s until restart.
  addLive(live);

  try {
    // Every DB step below is bounded (boundedDb): a stalled query must reject
    // into the catch so the live-map entry is cleaned up, never hang holding it.
    await boundedDb(
      db.insert(acpSessions).values({
        id,
        tenantId: live.tenantId,
        stationId,
        userId,
        mode,
        status: "starting",
        endedReason: null,
        nodeSessionId: null,
        createdAt: now,
        lastEventAt: now,
      }),
      "insert session row"
    );

    // The hub session id doubles as the ACP instance: stable by construction
    // across a re-open of this session, and it correlates node-side processes
    // back to this row in logs.
    const wire = await openAcpWire(nodeId, stationKey, id);
    live.wire = wire;
    live.nodeSessionId = wire.nodeSessionId;
    live.instanceEchoed = wire.instanceEchoed;

    // ── Compatibility layer 2 (post-open) ────────────────────────────────────
    // The node did not echo the instance, so this wire may well be the SAME
    // agent process a sibling is already talking to — two conversations on one
    // process and one input-frame key. Refuse rather than risk the bleed; the
    // catch below tears this wire down (error event + finalizeEnd + node close).
    // Layer 1 normally catches this first; this is the belt to its braces for
    // the case where no live sibling had recorded an echo verdict yet.
    if (!wire.instanceEchoed && otherLive(stationId, live).length > 0) {
      throw new Error(ACTIVE_SESSION_MESSAGE);
    }

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

    await withDeadline(
      connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agentpod-hub", version: "0.1.0" },
      }),
      handshakeTimeoutMs,
      HANDSHAKE_TIMEOUT_MESSAGE
    );
    const created = await withDeadline(
      connection.agent.request("session/new", {
        // The SDK requires an absolute cwd; the station workspace is the
        // natural one, "/" the fallback for workspace-less stations.
        cwd: workspacePath ?? "/",
        mcpServers: [],
      }),
      handshakeTimeoutMs,
      HANDSHAKE_TIMEOUT_MESSAGE
    );
    live.acpSessionId = created.sessionId;

    await boundedDb(
      db
        .update(acpSessions)
        .set({ nodeSessionId: wire.nodeSessionId })
        .where(eq(acpSessions.id, id)),
      "record node session id"
    );
    await boundedDb(setStatus(live, "idle").done, "idle state event");

    const rows = await boundedDb(
      db.select().from(acpSessions).where(eq(acpSessions.id, id)),
      "read back session row"
    );
    return toContract(rows[0]!);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    persistEvent(live, "error", { message: reason });
    await finalizeEnd(live, reason);
    throw err;
  }
}

// ─── Session listing ─────────────────────────────────────────────────────────

/** Page size when the caller doesn't say. */
const SESSION_PAGE_DEFAULT_LIMIT = 20;
/** Hard ceiling on one page — a station can accumulate thousands of sessions. */
const SESSION_PAGE_MAX_LIMIT = 100;

export interface ListSessionsOptions {
  /** Page size; defaults to 20 and is clamped into [1, 100]. */
  limit?: number;
  /**
   * `lastEventAt` cursor (ISO) from the last row of the previous page: return
   * only rows older than this. Pair it with `beforeId` — on its own it can only
   * express "strictly older", which LOSES rows tied on the timestamp.
   */
  before?: string;
  /**
   * `id` of the same cursor row, completing the keyset. With it the predicate
   * becomes (lastEventAt, id) < (before, beforeId) in the list's own ordering,
   * so rows sharing `before` resume exactly where the page stopped.
   */
  beforeId?: string;
}

/**
 * The page size to use for `limit`: default when absent or not a number,
 * otherwise floored into [1, 100].
 *
 * Out-of-range numbers are clamped rather than refused — a client asking for
 * 1000 rows gets 100, not an error. Deciding that a *non-numeric* limit is a
 * client bug worth a 400 is the route's job (it can't be told apart from a
 * default down here).
 */
export function clampSessionLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return SESSION_PAGE_DEFAULT_LIMIT;
  }
  return Math.min(SESSION_PAGE_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * One page of the caller's sessions for a station, newest ACTIVITY first (id
 * desc breaks same-millisecond ties). Ordered and limited in SQL — backed by
 * acp_sessions_station_activity_idx — so the console's session switcher and the
 * history view share one read; callers must not re-sort.
 *
 * Paging is keyset, not offset: pass the last row of the previous page back as
 * `before` (its lastEventAt) AND `beforeId` (its id), and rows arriving
 * meanwhile can't shift the page under the caller.
 *
 * Both halves matter. lastEventAt comes from `new Date()`, so several rows
 * sharing one millisecond is ordinary — and a timestamp-only cursor with
 * `lastEventAt < before` excludes every tied row from EVERY later page, not
 * just this one. A session tied with the page boundary would disappear from
 * history for good, silently. `beforeId` closes that hole by resuming inside
 * the tie group. It stays optional only for cross-version tolerance: a console
 * that sends `before` alone gets the old strict-older behaviour rather than an
 * error.
 */
export async function listSessions(
  userId: string,
  stationId: string,
  opts: ListSessionsOptions = {}
): Promise<AcpSessionRow[]> {
  const filters = [
    eq(acpSessions.userId, userId),
    eq(acpSessions.stationId, stationId),
  ];
  if (opts.before !== undefined) {
    const cursor = new Date(opts.before);
    if (Number.isNaN(cursor.getTime())) {
      throw new Error("Invalid page cursor.");
    }
    filters.push(
      opts.beforeId === undefined
        ? lt(acpSessions.lastEventAt, cursor)
        : // (lastEventAt, id) < (before, beforeId) — the list's own ordering.
          or(
            lt(acpSessions.lastEventAt, cursor),
            and(
              eq(acpSessions.lastEventAt, cursor),
              lt(acpSessions.id, opts.beforeId)
            )
          )!
    );
  }
  const rows = await db
    .select()
    .from(acpSessions)
    .where(and(...filters))
    .orderBy(desc(acpSessions.lastEventAt), desc(acpSessions.id))
    .limit(clampSessionLimit(opts.limit));
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

  // The first real prompt names the session, in the user-prompt's own write.
  // COALESCE is what makes "first" mean first: an existing title always wins,
  // so a long conversation keeps the label the user recognises no matter how
  // many prompts follow (and a whitespace-only prompt sets nothing at all).
  const title = deriveSessionTitle(text);
  const { done: promptWritten } = persistEvent(
    live,
    "user-prompt",
    { text },
    title === null ? {} : { title: sql`COALESCE(${acpSessions.title}, ${title})` }
  );
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
  // This session is not live, so its tenant is read back from the row rather
  // than carried in memory. Same rule as persistEvent: the event's tenant is the
  // session's, which the composite FK then checks.
  const [sessionRow] = await db
    .select({ tenantId: acpSessions.tenantId })
    .from(acpSessions)
    .where(eq(acpSessions.id, sessionId));
  if (!sessionRow) return;
  await db.insert(acpEvents).values({
    sessionId,
    tenantId: sessionRow.tenantId,
    seq,
    type: "state",
    payload,
    createdAt,
  });
  await db
    .update(acpSessions)
    .set({
      status: "ended",
      endedReason: reason,
      lastEventAt: createdAt,
      // This row is not live, so seq came from MAX(seq)+1 — the same
      // last_seq invariant persistEvent maintains for live sessions.
      lastSeq: seq,
    })
    .where(eq(acpSessions.id, sessionId));
  fanOut(sessionId, {
    sessionId,
    seq,
    type: "state",
    payload,
    createdAt: createdAt.toISOString(),
  });
}

/** Test hook: live subscriber count for a session (leak detection). */
export function _subscriberCountForTest(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}

/**
 * The stored transcript for a session, ordered by seq.
 *
 * Replay has always been the caller's job — the console's session socket does
 * this query inline. Doors needs the same read for `session/load`, where the
 * ACP protocol requires the AGENT to stream history back, so it lives here now
 * rather than being copied a second time.
 */
export async function readEvents(
  sessionId: string,
  sinceSeq = 0,
): Promise<Array<{ seq: number; type: string; payload: unknown }>> {
  const rows = await db
    .select({ seq: acpEvents.seq, type: acpEvents.type, payload: acpEvents.payload })
    .from(acpEvents)
    .where(and(eq(acpEvents.sessionId, sessionId), gt(acpEvents.seq, sinceSeq)))
    .orderBy(asc(acpEvents.seq));
  return rows as Array<{ seq: number; type: string; payload: unknown }>;
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
 * boot (log the rest). Each row's OWN node_session_id is closed — several rows
 * on one station now mean several distinct agent processes. Call from index.ts
 * boot after initDatabase.
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
    if (nodeId && isNodeSessionIdLive(nodeId, row.nodeSessionId)) {
      // A live session holds this process (only possible when a node shares one
      // process across sessions). Never close it out from under that session.
      log.info("ACP reconcile: node process held by a live session — not closed", {
        sessionId: row.id,
        nodeSessionId: row.nodeSessionId,
      });
      continue;
    }
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
 * best-effort acp.close per orphan, for that row's OWN node_session_id, and
 * clears the marker so it's once-only. Never touches non-ended rows, and skips
 * any process a live session is still holding, so live sessions are safe.
 *
 * Exported for tests; production calls it from the node-online hook below.
 */
export async function closeOrphanedProcesses(nodeId: string): Promise<void> {
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
    if (isNodeSessionIdLive(nodeId, orphan.nodeSessionId!)) {
      // A live session is talking to this very process (possible when a node
      // shares one process per station key): leave it — and its marker — alone.
      log.info("ACP orphan cleanup: process held by a live session — skipped", {
        sessionId: orphan.id,
        nodeId,
        nodeSessionId: orphan.nodeSessionId,
      });
      continue;
    }
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
