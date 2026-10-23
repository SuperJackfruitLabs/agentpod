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

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { acpTraceMeta } from "../telemetry/propagation";
import { assertSalaamManagedMcp } from "./salaam-mcp";
import {
  SalaamAcpFeatures,
  SalaamPromptReceipt,
  SalaamRunAuthority,
  SalaamExecutionFeatures,
  SalaamAcpFailure,
  SalaamCancellationReceipt,
} from "@agentpod/contract";
import {
  readSalaamCancellation,
  type SalaamCancellationState,
} from "./salaam-cancellations";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type McpServer,
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
  StationBusyHolder,
  TurnError,
  TurnErrorReport,
  TurnResolution,
} from "@agentpod/contract";
import { db } from "../db/drizzle";
import { ControlPairDenied, isControlPairEnforced } from "./control-pair";
import { grantAllowsPrincipal } from "./grants";
import {
  callerGrant,
  callerPrincipal,
  type TokenAuthority,
} from "../auth/caller-authority";
import {
  acpSessions,
  acpEvents,
  acpPromptRequests,
  type StoredSalaamExecution,
} from "../db/schema/acp";
import { stations } from "../db/schema/stations";
import { createLogger } from "../utils/logger";
import {
  bindSalaamPrompt,
  getSalaamPrompt,
  updateSalaamPrompt,
} from "./salaam-prompts";
import {
  makeSalaamExecution,
  admitSalaamExecution,
  renewSalaamExecution,
  revokeSalaamExecution,
  validateSalaamAuthority,
  salaamStationHolder,
  inspectSalaamExecution,
  type SalaamStationHolder,
} from "./salaam-authority";
import { principalDirectory } from "./org-plane/directory";
import { getStation } from "./station-registry";
import { gateCapability } from "../routes/station-writes";
import { connectionManager } from "./connection-manager";
import { recordAudit } from "./audit";
import {
  openAcpWire,
  type AcpWire,
  type OpenAcpWireOptions,
} from "./acp-transport";
import * as broker from "./broker";
import { nodes } from "../db/schema/nodes";
import { promptBlocks, type PromptImage } from "./matrix-as/attachments";
import {
  gatewayUnreachable,
  rejectionSaidNothing,
  turnErrorForSilentTurn,
  turnErrorForUnreachableGateway,
  turnErrorFromPlugin,
  turnErrorFromReason,
  turnErrorFromRejection,
} from "./turn-error";

const log = createLogger("acp-sessions");

// ─── Salaam idle end ──────────────────────────────────────────────────────────

/** Default minutes of no activity after which the hub ends an interactive Salaam session. */
export const SALAAM_IDLE_END_DEFAULT_MINUTES = 15;

/**
 * How long an interactive Salaam session may sit with no activity before the hub ends it
 * (`SALAAM_IDLE_END_MINUTES`, default 15). A Salaam station runs one execution at a time, so an
 * idle session left open holds the station against everyone else; ending it goes through the
 * normal end and confirmed revocation, and the session stays resumable. Fractions are allowed
 * (a short timeout for a live check); anything not a positive number is the default.
 */
export function salaamIdleEndMs(env: Record<string, string | undefined> = process.env): number {
  const minutes = Number(env.SALAAM_IDLE_END_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : SALAAM_IDLE_END_DEFAULT_MINUTES) * 60_000;
}

/** What the idle decision reads from a live session. */
export interface IdleCandidate {
  ended: boolean;
  status: AcpSessionStatus;
  turnInFlight: boolean;
  pendingPermissions: number;
  interactive: boolean;
  lastActivityAt: number;
}

/**
 * Is this session due to be ended for inactivity? Never mid-turn, never while a permission
 * prompt waits for its answer, never board work (its run owns its lifecycle), and only once the
 * last activity is at least `idleMs` old.
 */
export function idleEndDue(s: IdleCandidate, now: number, idleMs: number): boolean {
  return (
    !s.ended &&
    s.interactive &&
    s.status === "idle" &&
    !s.turnInFlight &&
    s.pendingPermissions === 0 &&
    now - s.lastActivityAt >= idleMs
  );
}

/** The reason the row records for an idle end. */
export function idleEndReason(idleMs: number): string {
  const minutes = idleMs / 60_000;
  const amount = Number.isInteger(minutes)
    ? `${minutes} minute${minutes === 1 ? "" : "s"}`
    : `${Math.round(idleMs / 1000)} seconds`;
  return `Ended after ${amount} without activity. Resume it to carry on.`;
}

// How long a session survives at `waiting` after its node goes offline before
// the hub gives up (no reattach in slice 2).
let offlineGraceMs = 60_000;

/** Test hook: shrink the offline grace period. */
export function _setOfflineGraceMsForTest(ms: number): void {
  offlineGraceMs = ms;
}

// How long a turn that ended with nothing waits for a harness plugin to say
// why. OpenClaw's bridge resolves `end_turn` before the plugin's report
// arrives: the plugin waits 2.5 s of quiet after the last model attempt (see
// integrations/openclaw/agentpod-errors), and real attempts land ~1 s apart.
const TURN_ERROR_GRACE_DEFAULT_MS = 5_000;
let turnErrorGraceMs = TURN_ERROR_GRACE_DEFAULT_MS;

/** Test hook: change the wait. Pass nothing to restore the default. */
export function _setTurnErrorGraceMsForTest(
  ms = TURN_ERROR_GRACE_DEFAULT_MS,
): void {
  turnErrorGraceMs = ms;
}

// A report for a turn that has already been given its error is still posted,
// as a follow-up, if it comes within this long. Later than that it cannot be
// told apart from a report about some other turn.
const LATE_TURN_ERROR_MS = 60_000;

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
    },
  );
}

/**
 * Reject with `message` if `promise` doesn't settle within `ms`.
 *
 * On timeout the underlying promise is left to settle later (the SDK rejects
 * it when the connection closes) — its eventual rejection is swallowed so it
 * never becomes an unhandled rejection.
 */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
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
      },
    );
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  stationId: string;
  /**
   * The workspace the station must be in (workspace authority spec, W4): any member may open a
   * session of their own on any of the workspace's stations. Required, so no caller can open a
   * session without naming the workspace it acts in.
   */
  tenantId: string;
  /** Whose session it is. Sessions stay a person's own (W4). */
  userId: string;
  mode: AcpSessionMode;
  /**
   * MCP servers to hand the harness when the session opens.
   *
   * Per session, not per station: the superpipeline entry carries a run-scoped
   * board credential, and a credential that outlives the run it was minted for
   * is a credential the next session on that machine can spend. Nothing here
   * is persisted — the row and the transcript the console reads never see it.
   *
   * Hermes does not DECLARE `mcpCapabilities` at `initialize`, and registers
   * `session/new`'s servers anyway (`acp_adapter/server.py` `new_session` →
   * `_register_session_mcp_servers`). So this is sent unconditionally rather
   * than gated on the declaration: gating on it would leave the one harness
   * the board actually dispatches to without its tools. An adapter that
   * ignores the field ignores it, and the bridge's own report still lands.
   *
   * Typed as the SDK's own `McpServer` because this is the SDK boundary — the
   * value goes to `session/new` unaltered. The contract's `AcpMcpServer`, which
   * is what callers build, is assignable to it and is the narrower of the two:
   * HTTP only.
   */
  mcpServers?: McpServer[];
  /**
   * Ask the station's node for its loopback MCP proxy (the hub's MCP server and Superlibrary's,
   * as the station's agent). Sent only to a node advertising `mcp.proxy`; the node decides and
   * says what it injected — read it with `sessionHasLibraryTools`. The proxy's secret stays on
   * the node: the hub never sees the URL's credential, only the server names.
   */
  mcpProxy?: boolean;
  /**
   * The caller's org-plane token authority, when the caller is the one asking (the console route).
   * Under ORG_PLANE_* the control pair is decided from it, never from a plane read (design §5.7).
   * Absent on the paths that act for the station's owner (the superpipeline bridge, Matrix
   * inbound): those read the directory, and a plane outage fails them closed with
   * `OrgPlaneUnavailable`. Ignored in legacy mode.
   */
  authority?: TokenAuthority;
  /**
   * The caller's role in the station's workspace, set ONLY by the console route (interactive
   * chat). An owner or admin may chat with the workspace's agent without a mayDispatch grant
   * (decision 3, spec 2026-10-23). Ignored whenever `executionRun` is set: dispatching board work
   * still needs the grant.
   */
  workspaceRole?: "owner" | "admin" | "member";
  /**
   * Set only by `resumeSession`: the ended session whose conversation this one continues. Never
   * copied from a request body.
   */
  resumeFrom?: string;
  /** Trusted bridge fields, never copied from an HTTP/ACP request body. */
  executionRun?: import("@agentpod/contract").SalaamRunAuthority;
  validateExecutionRun?: () => Promise<unknown>;
}

interface LiveSession {
  id: string;
  /** The session's tenant, carried so every event write inherits it. */
  tenantId: string;
  stationId: string;
  userId: string;
  nodeId: string;
  stationKey: string;
  /** Which harness answers, so an error can say whose failure it was. */
  harness: string;
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
  /** Did the current turn produce an update the transcript can show? */
  turnProduced: boolean;
  /** Parked ask-mode permission requests keyed by the request event's seq. */
  pending: Map<number, (resp: RequestPermissionResponse) => void>;
  ended: boolean;
  executionAuthority?: StoredSalaamExecution | null;
  authorityTimer?: ReturnType<typeof setInterval>;
  authorityRenewing?: boolean;
  transportLost?: boolean;
  recoveredTurn?: boolean;
  logicalPromptInFlight?: string;
  pendingCancellation?: SalaamCancellationState;
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
  /**
   * The harness's own name for this session, from `_meta.sessionKey` on its
   * session updates (OpenClaw: "agent:krishna:main"). How a plugin's report,
   * which knows only that name, finds this session.
   */
  harnessSessionKey: string | null;
  /** A prompt has been sent and has not yet settled. */
  turnInFlight: boolean;
  /** This turn already has its error event; a second would say it twice. */
  turnErrorRecorded: boolean;
  /** Where the last turn's recorded error came from, to tell a follow-up from a repeat. */
  turnErrorSource: TurnError["source"] | null;
  /** A plugin's report that arrived while the turn was still running. */
  pendingTurnError: TurnError | null;
  /** When the latest plugin report for this turn arrived. */
  pendingTurnErrorAt: number;
  /** When the agent last produced something a reader sees, this turn. */
  lastProducedAt: number;
  /** Set while a silent turn waits for a plugin's report. */
  awaitingTurnError: ((outcome: TurnError | TurnResolution) => void) | null;
  /**
   * A plugin said this turn's run ended well after all: a fallback answered,
   * or the agent chose silence (OpenClaw's NO_REPLY).
   */
  turnResolution: TurnResolution | null;
  /** When the last turn settled, for placing a late report. */
  lastTurnSettledAt: number;
  /**
   * Whether the agent said, at `initialize`, that it accepts image blocks
   * (`agentCapabilities.promptCapabilities.image`). False until it says so:
   * an image sent to an agent that never offered to take one is a turn it
   * fails, where a note in the text is a turn it can answer.
   */
  acceptsImages: boolean;
  /**
   * What a re-open needs, captured at open rather than re-read.
   *
   * Re-attaching is resuming THIS conversation on the node it is already on. A
   * station that has since moved, lost its workspace or changed its MCP servers is a
   * different place to run, and silently following it would resume somebody's
   * conversation somewhere they did not ask for. Re-reading would do exactly that.
   */
  workspacePath: string | null;
  mcpServers: McpServer[];
  /** Whether this session asks its node for the MCP proxy — captured at open, re-sent on re-attach. */
  mcpProxyRequested: boolean;
  /** What the node said it injected on the latest acp.open. */
  mcpProxied: string[];
  managedMcpVerified?: boolean;
  /** A re-attach is running; a second would race it for the same wire. */
  reattaching: boolean;
  /** Last time anything happened on this session (an event persisted, or the open). */
  lastActivityAt: number;
}

/** Live sessions per station — one-to-many since slice 4b. */
const liveByStation = new Map<string, Set<LiveSession>>();
const liveById = new Map<string, LiveSession>();
const subscribers = new Map<string, Set<(e: AcpEvent) => void>>();

/** Verbatim copy the routes map to 409 — do not reword (tests pin it). */
const ACTIVE_SESSION_MESSAGE =
  "An active session already exists for this agent.";

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
    endedCause: (r.endedCause as "idle" | "admin" | null) ?? null,
    resumedFrom: r.resumedFrom ?? null,
    resumedAs: r.resumedAs ?? null,
    resumable: isResumable(r),
    ...(r.executionAuthority
      ? {
          execution: {
            promptReceipts: 1 as const,
            state: r.executionAuthority.state,
            sessionId: r.executionAuthority.sessionId,
            stopConfirmed:
              r.executionAuthority.state === "revoked" &&
              r.executionAuthority.receipt?.owned_execution_stopped === true &&
              r.executionAuthority.receipt.unresolved_operations.length === 0,
          },
        }
      : {}),
  };
}

/**
 * An ended interactive Salaam session that nobody has resumed yet. Whether the CALLER may resume
 * it is the owner check in `resumeSession`; a row is only ever listed resumable to its owner.
 */
function isResumable(r: DbRow): boolean {
  return (
    r.status === "ended" &&
    r.executionAuthority?.binding.run.source === "agentpod" &&
    !r.resumedAs
  );
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
  const p = live.chain.then(fn);
  live.chain = p.catch((err) => {
    log.error("ACP event write failed", {
      sessionId: live.id,
      error: String(err),
    });
  });
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
  rowSet: SessionRowPatch = {},
): { seq: number; done: Promise<void> } {
  const seq = ++live.seq;
  const createdAt = new Date();
  live.lastActivityAt = createdAt.getTime();
  const done = enqueue(live, async () => {
    const inserted = await db.transaction(async (tx) => {
      const insert = tx.insert(acpEvents).values({
        sessionId: live.id,
        tenantId: live.tenantId,
        seq,
        type,
        payload: payload as object,
        createdAt,
      });
      // Only exact source/request identity duplicates are harmless. A conflicting
      // transcript sequence must still fail rather than silently losing an event.
      const data = payload as {
        _meta?: Record<string, unknown>;
        requestId?: string;
      };
      // Drizzle's column-only conflict API cannot target expression indexes.
      // Keep the insert built by the ORM, with a fixed, parameter-free target.
      const conflict =
        live.executionAuthority &&
        type === "agent-update" &&
        typeof data?._meta?.["salaam.dev/updateId"] === "string"
          ? sql`("session_id", ("payload" #>> '{_meta,salaam.dev/updateId}')) WHERE "type" = 'agent-update' AND "payload" #>> '{_meta,salaam.dev/updateId}' IS NOT NULL`
          : live.executionAuthority &&
              type === "user-prompt" &&
              typeof data?.requestId === "string"
            ? sql`("session_id", ("payload"->>'requestId')) WHERE "type" = 'user-prompt' AND "payload"->>'requestId' IS NOT NULL`
            : null;
      const rows = conflict
        ? await tx.execute<{ seq: number }>(
            sql`${insert.getSQL()} ON CONFLICT ${conflict} DO NOTHING RETURNING "seq"`,
          )
        : await insert.returning({ seq: acpEvents.seq });
      if (!rows.length) return false;
      await tx
        .update(acpSessions)
        .set({ lastEventAt: createdAt, lastSeq: seq, ...rowSet })
        .where(eq(acpSessions.id, live.id));
      return true;
    });
    if (!inserted) return;
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
  opts: {
    extra?: Record<string, unknown>;
    endedReason?: string;
    endedCause?: "idle" | "admin";
    force?: boolean;
  } = {},
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
      ...(opts.endedReason !== undefined
        ? { endedReason: opts.endedReason }
        : {}),
      ...(opts.endedCause !== undefined ? { endedCause: opts.endedCause } : {}),
    },
  );
}

/**
 * Build the ACP client over a wire and complete the handshake.
 *
 * Shared by the first open and by a re-attach, so the two can never drift into
 * handshaking differently — which would mean a resumed session quietly having
 * different capabilities from the one it replaced.
 */
function makeLive(
  input: Pick<
    LiveSession,
    | "id"
    | "tenantId"
    | "stationId"
    | "userId"
    | "nodeId"
    | "stationKey"
    | "harness"
    | "mode"
    | "workspacePath"
    | "mcpProxyRequested"
  > & { mcpServers?: McpServer[] },
): LiveSession {
  const {
    id,
    tenantId,
    stationId,
    userId,
    nodeId,
    stationKey,
    harness,
    mode,
    workspacePath,
    mcpProxyRequested,
  } = input;
  return {
    id,
    tenantId,
    stationId,
    userId,
    nodeId,
    stationKey,
    harness,
    mode,
    status: "starting",
    seq: 0,
    chain: Promise.resolve(),
    turnEpoch: 0,
    turnProduced: false,
    pending: new Map(),
    ended: false,
    wire: null,
    connection: null,
    agent: null,
    acpSessionId: "",
    nodeSessionId: null,
    instanceEchoed: null,
    graceTimer: null,
    harnessSessionKey: null,
    turnInFlight: false,
    turnErrorRecorded: false,
    turnErrorSource: null,
    pendingTurnError: null,
    pendingTurnErrorAt: 0,
    lastProducedAt: 0,
    awaitingTurnError: null,
    turnResolution: null,
    lastTurnSettledAt: 0,
    acceptsImages: false,
    workspacePath: workspacePath ?? null,
    mcpServers: input.mcpServers ?? [],
    mcpProxyRequested,
    mcpProxied: [],
    reattaching: false,
    lastActivityAt: Date.now(),
  };
}

async function connectAndHandshake(
  live: LiveSession,
  wire: AcpWire,
): Promise<void> {
  if (live.executionAuthority) {
    live.managedMcpVerified = false;
    const cancellation = await readSalaamCancellation(live.id);
    live.pendingCancellation =
      cancellation && cancellation.state !== "confirmed"
        ? cancellation
        : undefined;
  }
  const app = client({ name: "agentpod-hub" })
    .onNotification("session/update", ({ params }) => {
      handleSessionUpdate(live, params);
    })
    .onRequest("session/request_permission", ({ params }) =>
      handlePermissionRequest(live, params),
    );
  const connection = app.connect(ndJsonStream(wire.writable, wire.readable));
  live.connection = connection;
  live.agent = connection.agent;
  connection.closed.catch(() => {
    // Post-exit stream errors surface here; teardown runs via wire.closed.
  });
  void wire.closed.then(
    (reason) => {
      if (live.wire === wire) void handleWireClosed(live, reason, wire);
    },
    () => {
      if (live.wire === wire) void handleWireClosed(live, "wire error", wire);
    },
  );

  const initialized = await withDeadline(
    connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: live.executionAuthority
        ? {
            _meta: {
              "salaam.dev/features": { promptReceipts: 1, updateIds: 1 },
              "salaam.dev/executionFeatures": {
                failures: 1,
                cancellationReceipts: 1,
                toolSemantics: 1,
              },
            },
          }
        : {},
      clientInfo: { name: "agentpod-hub", version: "0.1.0" },
    }),
    handshakeTimeoutMs,
    HANDSHAKE_TIMEOUT_MESSAGE,
  );
  // Read, not assumed: every adapter probed on 2026-09-24 says yes, and the one
  // that someday says no should get a note instead of a failed turn.
  if (live.executionAuthority) {
    const meta = (initialized as { _meta?: Record<string, unknown> })._meta;
    if (!SalaamAcpFeatures.safeParse(meta?.["salaam.dev/features"]).success)
      throw Error(
        "Upgrade the Salaam adapter: durable prompt receipt and history support is required",
      );
    if (
      !SalaamExecutionFeatures.safeParse(meta?.["salaam.dev/executionFeatures"])
        .success
    )
      throw Error(
        "Upgrade the Salaam adapter: typed failures and confirmed cancellation receipts are required",
      );
    assertSalaamManagedMcp(initialized, wire.mcpProxy);
    live.managedMcpVerified = wire.mcpProxy.length > 0;
  }
  live.acceptsImages =
    (
      initialized as
        | { agentCapabilities?: { promptCapabilities?: { image?: boolean } } }
        | undefined
    )?.agentCapabilities?.promptCapabilities?.image === true;
  const created = await withDeadline(
    connection.agent.request(
      live.executionAuthority?.sessionId ? "session/load" : "session/new",
      {
        ...(live.executionAuthority?.sessionId
          ? { sessionId: live.executionAuthority.sessionId }
          : {}),
        // The SDK requires an absolute cwd; the station workspace is the natural
        // one, "/" the fallback for workspace-less stations.
        cwd: live.workspacePath ?? "/",
        mcpServers: live.mcpServers,
        // superwitness C2: the harness may continue the run's trace. Ids only.
        ...acpTraceMeta(),
      },
    ),
    handshakeTimeoutMs,
    HANDSHAKE_TIMEOUT_MESSAGE,
  );
  // ACP session/load accepts the supplied id and normally returns no sessionId.
  const returnedSession = (created as { sessionId?: string }).sessionId;
  if (
    live.executionAuthority?.sessionId &&
    returnedSession !== undefined &&
    returnedSession !== live.executionAuthority.sessionId
  )
    throw Error("Salaam ACP resumed a different session");
  live.acpSessionId = (live.executionAuthority?.sessionId ?? returnedSession)!;
  if (!live.acpSessionId)
    throw Error("ACP handshake returned no session identity");
}

/**
 * How many times a lost transport is re-attached, and how long between tries.
 *
 * Bounded, and short. A gateway that is coming back does so in seconds — it is a
 * service restart — so a long tail buys nothing. A gateway that is NOT coming back
 * must not turn into a process-spawn loop that runs for as long as the session row
 * exists, asking the node to start an agent every few seconds forever.
 */
const REATTACH_BACKOFF_MS = [1_000, 2_000, 4_000];

/**
 * Put the session back on a live agent process after its transport went away.
 *
 * Runs in the BACKGROUND, after the failure has already been reported. Making
 * somebody wait out a retry budget to be told what went wrong would be a worse
 * answer delivered later; they get the explanation at once, and the session quietly
 * becomes usable again behind it.
 *
 * It re-opens with the SAME instance — `live.id`, stable by construction — so the
 * node spawns the bridge against the same harness session key and the conversation
 * resumes rather than restarting. That is the whole reason the transcript survives a
 * gateway restart.
 *
 * Deliberately does NOT re-send the interrupted prompt. That turn was running inside
 * the thing that went away and may already have had effects; repeating it is the
 * person's decision to make, not this function's.
 */
async function reattachAfterTransportLoss(live: LiveSession): Promise<void> {
  if (live.reattaching || live.ended) return;
  live.reattaching = true;
  try {
    for (const wait of REATTACH_BACKOFF_MS) {
      await new Promise((r) => setTimeout(r, wait));
      // Every reason to stop, re-checked each pass: the session ended, somebody
      // started a new turn (which owns the wire now), or the node went away and the
      // offline path has it.
      if (live.ended || live.turnInFlight) return;
      if (!connectionManager.isOnline(live.nodeId)) continue;

      // Ask before spawning. Re-opening into a gateway that is still down costs the
      // node a process that will fail the same way, and tells the reader nothing.
      const probe = await broker.request(live.nodeId, "acp.transport", {
        key: live.stationKey,
      });
      if (probe.ok && gatewayUnreachable(probe.data)) continue;

      try {
        // The old wire is holding a dead socket; let it go before taking another.
        try {
          await live.wire?.close();
        } catch {
          // Already gone — which is the case this exists for.
        }
        const wire = await openAcpWire(
          live.nodeId,
          live.stationKey,
          live.id,
          proxyOptions(live),
        );
        if (live.ended) {
          await wire.close();
          return;
        }
        live.wire = wire;
        live.nodeSessionId = wire.nodeSessionId;
        live.instanceEchoed = wire.instanceEchoed;
        if (
          live.mcpProxyRequested &&
          wire.mcpProxy.join() !== live.mcpProxied.join()
        ) {
          // The prompt already named (or did not name) the tools; say so if the re-open differs.
          log.warn("ACP re-attach: the node's MCP proxy answer changed", {
            sessionId: live.id,
            before: live.mcpProxied,
            after: wire.mcpProxy,
          });
        }
        live.mcpProxied = wire.mcpProxy;
        await connectAndHandshake(live, wire);
        await db
          .update(acpSessions)
          .set({ nodeSessionId: wire.nodeSessionId })
          .where(eq(acpSessions.id, live.id));
        await setStatus(live, "idle").done;
        log.info("ACP session re-attached after its transport came back", {
          sessionId: live.id,
          stationId: live.stationId,
        });
        return;
      } catch (err) {
        log.warn("ACP re-attach attempt failed", {
          sessionId: live.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info(
      "ACP session not re-attached; its transport did not come back in time",
      {
        sessionId: live.id,
        stationId: live.stationId,
      },
    );
  } finally {
    live.reattaching = false;
  }
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

const finalizations = new WeakMap<LiveSession, Promise<void>>();
/** Every concurrent stop caller waits for the same authority/teardown barrier. */
function finalizeEnd(
  live: LiveSession,
  reason: string,
  cause?: "idle" | "admin",
): Promise<void> {
  const pending = finalizations.get(live);
  if (pending) return pending;
  if (live.ended) return Promise.resolve();
  live.ended = true;
  const completion = Promise.resolve().then(() => finalizeEndOnce(live, reason, cause));
  finalizations.set(live, completion);
  return completion;
}
/** Terminal transition: row ended(reason) + state event, wire torn down. */
async function finalizeEndOnce(
  live: LiveSession,
  reason: string,
  cause?: "idle" | "admin",
): Promise<void> {
  clearInterval(live.authorityTimer);
  if (live.executionAuthority)
    live.executionAuthority = await revokeSalaamExecution(live.id, reason);
  if (live.graceTimer) {
    clearTimeout(live.graceTimer);
    live.graceTimer = null;
  }
  // A session ending under a running turn is why that turn failed: the node
  // went away, or the harness exited. Recorded before the ended state, so
  // every reader meets the reason before the end.
  if (live.turnInFlight && !live.turnErrorRecorded) {
    let error =
      live.pendingTurnError ??
      turnErrorFromReason(reason, live.harness, "session-state");
    if (live.executionAuthority)
      error = {
        ...error,
        failureCode: error.failureCode ?? "execution_interrupted",
        ...(live.logicalPromptInFlight
          ? { logicalRequestId: live.logicalPromptInFlight }
          : {}),
        ...(live.executionAuthority.sessionId
          ? { localSessionId: live.executionAuthority.sessionId }
          : {}),
      };
    live.turnErrorRecorded = true;
    live.turnErrorSource = error.source;
    persistEvent(live, "error", error);
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
    extra: {
      reason,
      ...(live.executionAuthority
        ? {
            execution: {
              state: live.executionAuthority.state,
              stopConfirmed: live.executionAuthority.state === "revoked",
            },
          }
        : {}),
      ...(cause ? { cause } : {}),
    },
    endedReason: reason,
    ...(cause ? { endedCause: cause } : {}),
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
async function handleWireClosed(
  live: LiveSession,
  reason: string,
  closedWire: AcpWire,
): Promise<void> {
  if (live.ended || live.wire !== closedWire) return;
  if (live.executionAuthority && !live.ended) live.transportLost = true;
  try {
    // Contract note: always close() after `closed` settles (idempotent).
    await closedWire.close();
  } catch {
    // Already closed — fine.
  }
  if (live.ended || live.wire !== closedWire) return;
  if (live.executionAuthority) {
    live.transportLost = true;
    rejectPendingPermissions(live);
    await setStatus(live, "waiting", {
      extra: {
        reason:
          "Salaam transport detached; admitted daemon work retains its identity",
      },
      force: true,
    }).done;
    if (connectionManager.isOnline(live.nodeId)) void reconnectSalaam(live);
    if (!live.graceTimer) {
      live.graceTimer = setTimeout(
        () =>
          void finalizeEnd(
            live,
            "Salaam transport did not recover within its authority window",
          ),
        offlineGraceMs,
      );
      live.graceTimer.unref?.();
    }
    return;
  }
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

function handleSessionUpdate(
  live: LiveSession,
  params: SessionNotification,
): void {
  if (live.ended) return;
  if (live.executionAuthority) {
    const cancellation = (params.update as { _meta?: Record<string, unknown> })
      ._meta?.["salaam.dev/cancellationReceipt"];
    if (cancellation) {
      const parsed = SalaamCancellationReceipt.safeParse(cancellation);
      if (
        parsed.success &&
        parsed.data.sessionId === live.executionAuthority.sessionId &&
        parsed.data.targetRequestId
      ) {
        const receipt = parsed.data;
        void enqueue(live, async () => {
          const saved = await readSalaamCancellation(
            live.id,
            receipt.requestId,
          );
          if (
            !saved ||
            saved.targetRequestId !== receipt.targetRequestId ||
            saved.state === "confirmed"
          )
            return;
          const prompt = await getSalaamPrompt(
            live.userId,
            live.id,
            receipt.targetRequestId!,
          );
          if (
            prompt.attemptId &&
            !receipt.attemptIds.includes(prompt.attemptId)
          )
            return;
          const current = await readSalaamCancellation(live.id);
          const applies =
            current?.requestId === receipt.requestId &&
            (!live.logicalPromptInFlight ||
              live.logicalPromptInFlight === receipt.targetRequestId);
          if (receipt.state === "confirmed")
            await updateSalaamPrompt(
              live.id,
              receipt.targetRequestId!,
              "interrupted",
            );
          if (applies)
            live.pendingCancellation = receipt as SalaamCancellationState;
          const status = applies
            ? receipt.state === "confirmed"
              ? "idle"
              : live.turnInFlight && receipt.state === "requested"
                ? "working"
                : "waiting"
            : live.status;
          // State writes queue after this item; never await our own queue.
          setStatus(live, status, {
            extra: { cancellation: receipt },
            force: true,
          });
        });
      }
      return;
    }
    const raw = (params.update as { _meta?: Record<string, unknown> })._meta?.[
      "salaam.dev/promptReceipt"
    ];
    if (raw) {
      const parsed = SalaamPromptReceipt.safeParse(raw);
      if (
        parsed.success &&
        parsed.data.sessionId === live.executionAuthority.sessionId &&
        parsed.data.attemptId
      ) {
        const { requestId, state, attemptId } = parsed.data;
        void enqueue(live, async () => {
          const receipt = await updateSalaamPrompt(
            live.id,
            requestId,
            state,
            attemptId,
          );
          // Append after this queue item; do not await a write queued behind itself.
          persistEvent(live, "state", {
            status: live.status,
            promptReceipt: receipt,
          });
        });
      }
      return;
    }
    // The Hub already saved the logical user event before dispatch. ACP load replays it.
    if (params.update.sessionUpdate === "user_message_chunk") return;
  }
  // `session_info` can rename the session but leaves the chat empty. Only mark
  // a turn productive when the console has an agent update to render.
  const update = params.update as { sessionUpdate?: unknown };
  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk" ||
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update"
  ) {
    live.turnProduced = true;
    live.lastProducedAt = Date.now();
  }
  const meta = (params.update as { _meta?: unknown })._meta;
  if (meta && typeof meta === "object") {
    const key = (meta as { sessionKey?: unknown }).sessionKey;
    if (typeof key === "string" && key !== "") live.harnessSessionKey = key;
  }
  // Every SDK sessionUpdate notification → agent-update with the raw update.
  persistEvent(live, "agent-update", params.update);
}

function handlePermissionRequest(
  live: LiveSession,
  params: RequestPermissionRequest,
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
        (o) => o.kind === "allow_once" || o.kind === "allow_always",
      ) ?? params.options[0];
    const { seq: requestSeq } = persistEvent(live, "permission-request", {
      toolCall: params.toolCall,
      options: params.options,
      auto: true,
    });
    if (!option) {
      persistEvent(live, "permission-answer", {
        requestSeq,
        cancelled: true,
        auto: true,
      });
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
  fn: () => Promise<T>,
): Promise<T> {
  const prev = openLocks.get(stationId);
  const run = (async () => {
    if (prev) await prev.catch(() => {});
    return withDeadline(fn(), openPhaseTimeoutMs(), OPEN_PHASE_TIMEOUT_MESSAGE);
  })();
  openLocks.set(stationId, run);
  void run
    .then(
      () => {},
      () => {},
    )
    .then(() => {
      if (openLocks.get(stationId) === run) openLocks.delete(stationId);
    });
  return run;
}

/** Whether a session could be opened here right now, and if not, why not. */
export interface StationReadiness {
  ready: boolean;
  /** The sentence `createSession` would have thrown. Absent when ready. */
  reason?: string;
  /** A Salaam station's one live execution, when that is what refused. */
  holder?: SalaamStationHolder;
}

/** The generic refusal sentence, for readers that cannot say who (the bridge's readiness). */
export const STATION_BUSY_REASON =
  "Another session holds this agent's one live execution; it takes one at a time.";

/**
 * A Salaam station already runs someone's execution (one at a time: an agent must never act on
 * two people's authority at once). Carries who, and since when, so the refusal can say so.
 */
export class SalaamStationBusy extends Error {
  override name = "SalaamStationBusy";
  readonly code = "station_busy";
  constructor(readonly holder: StationBusyHolder) {
    const who = holder.you ? "You are" : `${holder.name} is`;
    super(
      holder.state === "stopping"
        ? `${holder.you ? "Your" : `${holder.name}'s`} last session with this agent is still stopping (since ${holder.since}). It takes one at a time.`
        : `${who} in a session with this agent since ${holder.since}. It takes one at a time.`,
    );
  }
}

export function isSalaamStationBusy(e: unknown): e is SalaamStationBusy {
  return e instanceof SalaamStationBusy || (e as { name?: string })?.name === "SalaamStationBusy";
}

/** A person's display name for a refusal or a list; never throws (a plane outage says "Someone"). */
async function displayName(userId: string): Promise<string> {
  try {
    const p = await principalDirectory().principal(userId);
    return p?.displayName || p?.handle || "Someone";
  } catch {
    return "Someone";
  }
}

async function busyRefusal(holder: SalaamStationHolder, callerId: string): Promise<SalaamStationBusy> {
  const you = holder.userId === callerId;
  return new SalaamStationBusy({
    name: you ? "You" : await displayName(holder.userId),
    you,
    since: holder.since.toISOString(),
    state: holder.state,
    ...(you ? { sessionId: holder.sessionId } : {}),
  });
}

/**
 * Can a session be opened on this station at all?
 *
 * The same three gates `createSession` fails fast on, asked without opening
 * anything — for callers that want to know *before* they take on an obligation
 * they would then have to unwind. The superpipeline bridge is the first: it claims a
 * card from a board and a claim it cannot execute strands that card until the
 * board's 15-minute reclaim, so it asks here first.
 *
 * Deliberately no stricter than the open it stands in front of. A probe that
 * refused a station `createSession` would have accepted turns every start into
 * an outage with no error anywhere — the caller simply never acts.
 */
export async function stationReadiness(
  scope: { tenantId: string },
  stationId: string,
): Promise<StationReadiness> {
  const station = await getStation(scope, stationId);
  if (!station) return { ready: false, reason: "Station not found." };
  if (!gateCapability(station, "acp")) {
    return {
      ready: false,
      reason: "This station does not support agent sessions.",
    };
  }
  if (!connectionManager.isOnline(station.nodeId)) {
    return { ready: false, reason: "Node is offline." };
  }
  if (station.harness === "salaam") {
    const holder = await salaamStationHolder(station.id);
    if (holder) return { ready: false, reason: STATION_BUSY_REASON, holder };
  }
  return { ready: true };
}

/**
 * Decision 3 (spec 2026-10-23): a workspace owner or admin chatting with the workspace's agent
 * from the console needs no separate mayDispatch grant. Interactive only: a bridge run (any
 * `executionRun`) never qualifies, whatever role is passed.
 */
export function interactiveWorkspaceAdmin(input: Pick<CreateSessionInput, "workspaceRole" | "executionRun">): boolean {
  return input.executionRun === undefined && (input.workspaceRole === "owner" || input.workspaceRole === "admin");
}

export async function createSession(
  input: CreateSessionInput,
): Promise<AcpSessionRow> {
  const { stationId, userId, tenantId } = input;

  // ── The control pair, first half: may this principal dispatch this agent? ──
  //
  // Decision 4 of charter decisions/2026-08-13-ecosystem-identity.md, enforced
  // HERE because this is the one choke point both dispatch paths pass through:
  // the console/API route and the superpipeline bridge. A check in superpipeline alone
  // would cover board-driven work while provisioning straight at AgentPod — the
  // most common path today — went unguarded, and "a control with a hole that
  // shape is not a control".
  //
  // Unconfigured is off; configured is fail-closed. Before the readiness gates
  // on purpose: whether a caller is ALLOWED to reach a station does not depend
  // on whether that station happens to be online, and answering "node offline"
  // to someone who was never permitted leaks which stations exist.
  const station = await getStation({ tenantId }, stationId);
  if (station && isControlPairEnforced() && !interactiveWorkspaceAdmin(input)) {
    // The grant is keyed by principal id, not the session's `userId`. A caller
    // with no principal has no grant to hold. Under the org plane a caller's
    // token answers both (`auth/caller-authority.ts`).
    const caller = { id: userId, authority: input.authority };
    const principal = await callerPrincipal(caller);
    const allowed =
      principal !== null &&
      grantAllowsPrincipal(
        await callerGrant(caller, principal.id),
        station.principalId,
      );

    if (!allowed) {
      log.warn("dispatch refused by the control pair", {
        userId,
        principalId: principal?.id ?? null,
        stationKey: station.stationKey,
        stationId,
      });
      throw new ControlPairDenied(userId, station.stationKey);
    }
  }

  // Fail fast on the obvious gates before queueing (openSession re-checks them
  // under the lock, where the answers are current).
  const readiness = await stationReadiness({ tenantId }, stationId);
  if (!readiness.ready)
    throw readiness.holder
      ? await busyRefusal(readiness.holder, userId)
      : new Error(readiness.reason);

  return withStationOpenLock(stationId, () => openSession(input));
}

async function openSession(input: CreateSessionInput): Promise<AcpSessionRow> {
  const { stationId, userId, mode } = input;

  // Re-read the station and its node's presence: a queued open can start a
  // minute after createSession was called, by which time the station may have
  // been re-adopted onto another node, lost the capability, or gone offline.
  // The open must target CURRENT routing, never the snapshot from the queue.
  const station = await getStation({ tenantId: input.tenantId }, stationId);
  if (!station) throw new Error("Station not found.");
  if (!gateCapability(station, "acp")) {
    throw new Error("This station does not support agent sessions.");
  }
  if (!connectionManager.isOnline(station.nodeId)) {
    throw new Error("Node is offline.");
  }
  const { nodeId, stationKey, workspacePath, harness } = station;
  if (harness === "salaam") {
    const holder = await salaamStationHolder(station.id);
    if (holder) throw await busyRefusal(holder, userId);
  }
  if (input.resumeFrom !== undefined && harness !== "salaam")
    throw new SessionNotResumable("Only an interactive Salaam session can be resumed.");
  // Asked only of a node that runs the proxy; read before the sibling check, so no await
  // separates that check from addLive.
  const mcpProxyRequested =
    input.mcpProxy === true && (await nodeHasCapability(nodeId, "mcp.proxy"));

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
  // tenants by a later re-resolution. It is the station's tenant: a session is
  // a child of the station it runs on (W5), never of the user opening it.
  const tenantId = station.tenantId;
  const execution =
    harness === "salaam"
      ? await makeSalaamExecution(stationId, userId, id, input.executionRun, {
          workspaceAdmin: interactiveWorkspaceAdmin(input),
          ...(input.resumeFrom !== undefined ? { continueFrom: input.resumeFrom } : {}),
        })
      : null;
  if (execution && input.mcpServers?.length)
    throw Error("Salaam managed MCP is not enabled yet");
  if (execution?.binding.run.source === "superpipeline") {
    if (!input.validateExecutionRun)
      throw Error("Salaam board admission requires a fresh run-owner check");
    await input.validateExecutionRun();
  }
  const live = makeLive({
    id,
    tenantId,
    stationId,
    userId,
    nodeId,
    stationKey,
    harness,
    mode,
    workspacePath: workspacePath ?? null,
    mcpProxyRequested,
    mcpServers: input.mcpServers,
  });
  live.executionAuthority = execution;

  // Register before any await so siblings (and the layers above) can see this
  // session while it is starting. Every failure exit below MUST run
  // finalizeEnd, which removes these entries — a leaked entry would wedge the
  // station with 409s until restart.
  addLive(live);

  // A resume claims its predecessor once, atomically: two resumes of one conversation would fork
  // it into two branches. Released below if nothing was admitted, so the person can try again.
  let claimed = false;
  try {
    if (input.resumeFrom !== undefined) {
      const [won] = await boundedDb(
        db
          .update(acpSessions)
          .set({ resumedAs: id })
          .where(
            and(
              eq(acpSessions.id, input.resumeFrom),
              eq(acpSessions.userId, userId),
              isNull(acpSessions.resumedAs),
            ),
          )
          .returning({ id: acpSessions.id }),
        "claim resumed session",
      );
      if (!won) throw new SessionNotResumable("This session was already resumed.");
      claimed = true;
    }
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
        executionAuthority: execution,
        mcpProxyRequested,
        resumedFrom: input.resumeFrom ?? null,
        createdAt: now,
        lastEventAt: now,
      }),
      "insert session row",
    );
    if (input.resumeFrom !== undefined) await carryTranscript(live, input.resumeFrom);

    // The hub session id doubles as the ACP instance: stable by construction
    // across a re-open of this session, and it correlates node-side processes
    // back to this row in logs.
    if (execution) {
      await admitSalaamExecution(id, userId);
      live.executionAuthority = await renewSalaamExecution(id, userId);
    }
    const wire = await openAcpWire(nodeId, stationKey, id, proxyOptions(live));
    live.wire = wire;
    live.nodeSessionId = wire.nodeSessionId;
    live.instanceEchoed = wire.instanceEchoed;
    live.mcpProxied = wire.mcpProxy;

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

    await connectAndHandshake(live, wire);

    await boundedDb(
      db
        .update(acpSessions)
        .set({ nodeSessionId: wire.nodeSessionId })
        .where(eq(acpSessions.id, id)),
      "record node session id",
    );
    await boundedDb(
      setStatus(
        live,
        "idle",
        input.resumeFrom !== undefined ? { extra: { resumedFrom: input.resumeFrom } } : {},
      ).done,
      "idle state event",
    );
    startSalaamAuthorityWatch(live);

    const rows = await boundedDb(
      db.select().from(acpSessions).where(eq(acpSessions.id, id)),
      "read back session row",
    );
    return toContract(rows[0]!);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    persistEvent(live, "error", turnErrorFromRejection(err, live.harness));
    await finalizeEnd(live, reason);
    // Salaam never admitted the continuation, so the conversation was not carried anywhere:
    // give the claim back. Once admitted, the new session holds the history and is the one to
    // resume.
    if (claimed && !live.executionAuthority?.sessionId)
      await db
        .update(acpSessions)
        .set({ resumedAs: null })
        .where(and(eq(acpSessions.id, input.resumeFrom!), eq(acpSessions.resumedAs, id)))
        .catch(() => {});
    throw err;
  }
}

/**
 * Copy the resumed session's transcript into the new one, so the console (and any reader of this
 * session's events) sees one conversation. State events stay behind: an `ended` among them would
 * read as this session ending. Seqs are renumbered from 1; the live counter continues after them.
 */
async function carryTranscript(live: LiveSession, from: string): Promise<void> {
  const rows = await boundedDb(
    db
      .select()
      .from(acpEvents)
      .where(and(eq(acpEvents.sessionId, from), ne(acpEvents.type, "state")))
      .orderBy(asc(acpEvents.seq)),
    "read resumed transcript",
  );
  const [prior] = await boundedDb(
    db.select({ title: acpSessions.title }).from(acpSessions).where(eq(acpSessions.id, from)),
    "read resumed title",
  );
  if (rows.length) {
    await boundedDb(
      db.insert(acpEvents).values(
        rows.map((r, i) => ({
          sessionId: live.id,
          tenantId: live.tenantId,
          seq: i + 1,
          type: r.type,
          payload: r.payload as object,
          createdAt: r.createdAt,
        })),
      ),
      "carry resumed transcript",
    );
  }
  live.seq = rows.length;
  await boundedDb(
    db
      .update(acpSessions)
      .set({ lastSeq: rows.length, title: prior?.title ?? null })
      .where(eq(acpSessions.id, live.id)),
    "record carried transcript",
  );
}

/** A resume that cannot happen: not ended, not Salaam, already resumed, or stop unconfirmed. */
export class SessionNotResumable extends Error {
  override name = "SessionNotResumable";
}
export function isSessionNotResumable(e: unknown): e is SessionNotResumable {
  return e instanceof SessionNotResumable || (e as { name?: string })?.name === "SessionNotResumable";
}

/**
 * Resume an ended interactive Salaam session: the same conversation (Salaam carries its history
 * into a new admission, the hub carries the transcript), under a FRESH execution authority for
 * the person resuming. They pass every check a new session does (the control pair or decision 3,
 * the one-live-execution rule), because it IS a new session.
 *
 * Owner only. An admin can see and end another person's session, but resuming it would carry
 * that person's conversation, and whatever they told the agent, into the admin's own authority.
 * Restricting resume to the owner keeps one conversation on one person's authority from start to
 * end. Someone else's session is "not found", as on every other per-session door.
 */
export async function resumeSession(
  input: Omit<CreateSessionInput, "stationId" | "mode" | "resumeFrom" | "executionRun" | "validateExecutionRun"> & {
    sessionId: string;
    mode?: AcpSessionMode;
  },
): Promise<AcpSessionRow> {
  const [prior] = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, input.sessionId), eq(acpSessions.tenantId, input.tenantId)));
  if (!prior || prior.userId !== input.userId) throw new Error("Session not found.");
  if (prior.status !== "ended") throw new SessionNotResumable("This session is still running.");
  const saved = prior.executionAuthority;
  if (!saved || saved.binding.run.source !== "agentpod")
    throw new SessionNotResumable("Only an interactive Salaam session can be resumed.");
  if (prior.resumedAs) throw new SessionNotResumable("This session was already resumed.");
  if (saved.state !== "revoked") {
    const status = await revokeSalaamExecution(prior.id, "Reconcile before resume");
    if (status?.state !== "revoked")
      throw new SessionNotResumable(
        "This session's last execution has not been confirmed stopped yet. Try again in a moment.",
      );
  }
  const { sessionId, mode, ...rest } = input;
  return createSession({
    ...rest,
    stationId: prior.stationId,
    mode: mode ?? (prior.mode as AcpSessionMode),
    resumeFrom: sessionId,
  });
}

// ─── Session listing ─────────────────────────────────────────────────────────

/** Page size when the caller doesn't say. */
const SESSION_PAGE_DEFAULT_LIMIT = 20;
/** Hard ceiling on one page — a station can accumulate thousands of sessions. */
const SESSION_PAGE_MAX_LIMIT = 100;

export interface ListSessionsOptions {
  /** Every person's sessions on the station (a workspace owner/admin's read). */
  everyone?: boolean;
  /** Name each row's owner (`owner`), for a list that can hold other people's sessions. */
  withOwners?: boolean;
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
  opts: ListSessionsOptions = {},
): Promise<AcpSessionRow[]> {
  const filters = [eq(acpSessions.stationId, stationId)];
  // Everyone's sessions only for a workspace owner/admin, and only when asked for (the history
  // dialog). The caller must already have scoped the station to their workspace.
  if (!opts.everyone) filters.push(eq(acpSessions.userId, userId));
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
              lt(acpSessions.id, opts.beforeId),
            ),
          )!,
    );
  }
  const rows = await db
    .select()
    .from(acpSessions)
    .where(and(...filters))
    .orderBy(desc(acpSessions.lastEventAt), desc(acpSessions.id))
    .limit(clampSessionLimit(opts.limit));
  if (!opts.withOwners) return rows.map(toContract);
  const names = new Map<string, string>();
  for (const id of new Set(rows.map((r) => r.userId)))
    if (id !== userId) names.set(id, await displayName(id));
  return rows.map((r) => {
    const you = r.userId === userId;
    const row = toContract(r);
    // Only the owner may resume (see resumeSession), so nobody else is told it is resumable.
    return { ...row, resumable: you && row.resumable, owner: { name: you ? "You" : names.get(r.userId)!, you } };
  });
}

export async function getSession(
  userId: string,
  sessionId: string,
): Promise<AcpSessionRow | null> {
  const rows = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)));
  return rows[0] ? toContract(rows[0]) : null;
}

/** What `promptSession` throws for a session still in a turn. Matched, not parsed. */
export const SESSION_BUSY_MESSAGE =
  "Session is busy — wait for the current turn to finish.";

/**
 * Whether a live session is mid-turn. A session that is not live — ended, or
 * never opened on this hub — is not busy: prompting it creates or fails, it
 * does not wait.
 */
export function sessionIsBusy(sessionId: string): boolean {
  const live = liveById.get(sessionId);
  return !!live && !live.ended && live.status !== "idle";
}

/**
 * Resolve when the session can take a prompt ("idle"), can no longer answer
 * ("ended"), or has been working for `timeoutMs` ("timeout").
 *
 * Built on the same event fan-out the console and the rooms listen to, so it
 * cannot disagree with them about when a turn ended.
 */
export function whenIdle(
  sessionId: string,
  timeoutMs = 15 * 60_000,
): Promise<"idle" | "ended" | "timeout"> {
  const live = liveById.get(sessionId);
  if (!live || live.ended) return Promise.resolve("ended");
  if (live.status === "idle") return Promise.resolve("idle");
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: "idle" | "ended" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = subscribe(sessionId, (event) => {
      if (event.type !== "state") return;
      const status = (event.payload as { status?: string } | undefined)?.status;
      if (status === "idle") finish("idle");
      else if (status === "ended") finish("ended");
    });
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

/**
 * Whether a node reads hub frames large enough for an image — it advertised
 * "frames.large" in its last hello. Read at prompt time, not cached: a node
 * that updates mid-session should get images from its next turn.
 */
async function nodeReadsLargeFrames(nodeId: string): Promise<boolean> {
  return nodeHasCapability(nodeId, "frames.large");
}

/** Whether a node advertised a capability in its last hello. */
async function nodeHasCapability(
  nodeId: string,
  capability: string,
): Promise<boolean> {
  const rows = await db
    .select({ capabilities: nodes.capabilities })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  const caps = rows[0]?.capabilities;
  return Array.isArray(caps) && caps.includes(capability);
}

/** The acp.open options a session's (re-)open sends. */
export async function renewExecution(
  userId: string,
  sessionId: string,
  run?: import("@agentpod/contract").SalaamRunAuthority,
): Promise<void> {
  const live = requireLive(userId, sessionId);
  if (!live.executionAuthority) return;
  const expected = live.executionAuthority.binding.run;
  if (
    expected.source === "superpipeline" &&
    (!SalaamRunAuthority.safeParse(run).success ||
      JSON.stringify(SalaamRunAuthority.parse(expected)) !==
        JSON.stringify(SalaamRunAuthority.parse(run)))
  )
    throw Error("The board work owner must renew this Salaam run");
  try {
    live.executionAuthority = await renewSalaamExecution(sessionId, userId);
  } catch (error) {
    await finalizeEnd(
      live,
      "Salaam execution authority could not be revalidated",
    );
    throw error;
  }
}

function idleCandidate(live: LiveSession): IdleCandidate {
  return {
    ended: live.ended,
    status: live.status,
    turnInFlight: live.turnInFlight,
    pendingPermissions: live.pending.size,
    interactive: live.executionAuthority?.binding.run.source === "agentpod",
    lastActivityAt: live.lastActivityAt,
  };
}

/**
 * End every interactive Salaam session idle for `idleMs` (spec: session lifecycle, 2026-10-23).
 * Each goes through `finalizeEnd`, the same end and confirmed revocation as a person's own end, and
 * its row records `endedCause: "idle"`. Runs on each session's authority tick; exported so a test
 * can drive it with its own clock. Returns the ids it ended.
 */
export async function endIdleSalaamSessions(
  now: number = Date.now(),
  idleMs: number = salaamIdleEndMs(),
): Promise<string[]> {
  const due = [...liveById.values()].filter(
    (live) => live.executionAuthority && idleEndDue(idleCandidate(live), now, idleMs),
  );
  await Promise.all(
    due.map((live) => {
      log.info("Ending idle Salaam session", { sessionId: live.id, stationId: live.stationId });
      return finalizeEnd(live, idleEndReason(idleMs), "idle");
    }),
  );
  return due.map((live) => live.id);
}

function startSalaamAuthorityWatch(live: LiveSession): void {
  if (!live.executionAuthority || live.authorityTimer) return;
  live.authorityTimer = setInterval(() => {
    const idleMs = salaamIdleEndMs();
    if (idleEndDue(idleCandidate(live), Date.now(), idleMs)) {
      void finalizeEnd(live, idleEndReason(idleMs), "idle");
      return;
    }
    if (
      live.ended ||
      live.authorityRenewing ||
      !connectionManager.isOnline(live.nodeId)
    )
      return;
    live.authorityRenewing = true;
    void (async () => {
      try {
        if (live.executionAuthority!.binding.run.source === "agentpod")
          live.executionAuthority = await renewSalaamExecution(
            live.id,
            live.userId,
          );
        else
          await validateSalaamAuthority(
            live.executionAuthority!.binding,
            live.userId,
          );
        if (live.recoveredTurn) await projectRecoveredSalaamTurn(live);
      } catch {
        await finalizeEnd(
          live,
          "Salaam execution authority could not be revalidated",
        );
      } finally {
        live.authorityRenewing = false;
      }
    })();
  }, 15_000);
  live.authorityTimer.unref?.();
}

async function projectRecoveredSalaamTurn(live: LiveSession): Promise<void> {
  const status = await inspectSalaamExecution(live.executionAuthority!);
  if (status.revoked) {
    await finalizeEnd(live, "Salaam execution authority was revoked");
    return;
  }
  if (
    live.pendingCancellation &&
    live.pendingCancellation.state !== "confirmed"
  ) {
    await resendSalaamCancellation(live);
    await setStatus(live, "waiting", {
      extra: { cancellation: live.pendingCancellation },
      force: true,
    }).done;
    return;
  }
  if (status.interrupted_attempts.length) {
    await setStatus(live, "waiting", {
      extra: {
        reason:
          "Salaam attempt was interrupted; inspect and explicitly continue it",
      },
    }).done;
    return;
  }
  if (status.active_attempts.length) {
    await setStatus(live, "working").done;
    return;
  }
  live.recoveredTurn = false;
  await setStatus(live, "idle").done;
}

async function reconnectSalaam(live: LiveSession): Promise<void> {
  if (
    live.reattaching ||
    live.ended ||
    !live.executionAuthority ||
    !connectionManager.isOnline(live.nodeId)
  )
    return;
  live.reattaching = true;
  try {
    if (live.executionAuthority.binding.run.source === "agentpod")
      live.executionAuthority = await renewSalaamExecution(
        live.id,
        live.userId,
      );
    else
      await validateSalaamAuthority(
        live.executionAuthority.binding,
        live.userId,
      );
    try {
      live.connection?.close();
      await live.wire?.close();
    } catch {}
    const wire = await openAcpWire(
      live.nodeId,
      live.stationKey,
      live.id,
      proxyOptions(live),
    );
    if (live.ended) {
      await wire.close();
      return;
    }
    live.wire = wire;
    live.nodeSessionId = wire.nodeSessionId;
    live.instanceEchoed = wire.instanceEchoed;
    await connectAndHandshake(live, wire);
    if (live.graceTimer) {
      clearTimeout(live.graceTimer);
      live.graceTimer = null;
    }
    live.transportLost = false;
    live.recoveredTurn = true;
    await db
      .update(acpSessions)
      .set({ nodeSessionId: wire.nodeSessionId })
      .where(eq(acpSessions.id, live.id));
    await projectRecoveredSalaamTurn(live);
    startSalaamAuthorityWatch(live);
    await live.chain;
    // Prepared means the dispatch marker never committed. Unknown/dispatched work is inspected, never automatically sent again.
    if (
      live.status === "idle" &&
      live.executionAuthority?.binding.run.source === "agentpod"
    ) {
      const [prepared] = await db
        .select()
        .from(acpPromptRequests)
        .where(
          and(
            eq(acpPromptRequests.sessionId, live.id),
            eq(acpPromptRequests.state, "prepared"),
          ),
        );
      if (prepared)
        await dispatchPrompt(
          live.userId,
          live.id,
          prepared.inputText,
          [],
          undefined,
          prepared.requestId,
        );
    }
  } catch {
    await finalizeEnd(
      live,
      "Salaam transport recovery could not revalidate its saved authority",
    );
  } finally {
    live.reattaching = false;
  }
}

async function restoreSalaamRow(
  row: typeof acpSessions.$inferSelect,
): Promise<void> {
  if (!row.executionAuthority || liveById.has(row.id)) return;
  const saved = row.executionAuthority;
  if (
    saved.state !== "active" ||
    saved.binding.run.source === "superpipeline"
  ) {
    await revokeSalaamExecution(
      row.id,
      "Hub restart requires the board work owner to recover explicitly",
    );
    if (row.status !== "ended")
      await appendEndedState(
        row.id,
        "Hub restart interrupted board execution; no prompt was replayed",
      );
    return;
  }
  if (!connectionManager.isOnline(saved.binding.node_id)) {
    await db
      .update(acpSessions)
      .set({ status: "waiting" })
      .where(eq(acpSessions.id, row.id));
    return;
  }
  const b = saved.binding;
  const live = makeLive({
    id: row.id,
    tenantId: row.tenantId,
    stationId: row.stationId,
    userId: row.userId,
    nodeId: b.node_id,
    stationKey: b.station_key,
    harness: "salaam",
    mode: row.mode as AcpSessionMode,
    workspacePath: b.workspace,
    mcpProxyRequested: row.mcpProxyRequested,
  });
  live.seq = row.lastSeq;
  // Idle time keeps counting across a hub restart: a session idle for 14 minutes before it is
  // not given a fresh 15.
  live.lastActivityAt = row.lastEventAt.getTime();
  live.executionAuthority = saved;
  live.acpSessionId = saved.sessionId ?? "";
  live.transportLost = true;
  addLive(live);
  await reconnectSalaam(live);
}

export async function recoverSalaamForNode(nodeId: string): Promise<void> {
  const rows = await db
    .select()
    .from(acpSessions)
    .where(sql`${acpSessions.executionAuthority} IS NOT NULL`);
  for (const row of rows)
    if (row.executionAuthority!.binding.node_id === nodeId) {
      if (row.executionAuthority!.state === "revocation_pending")
        await revokeSalaamExecution(
          row.id,
          "Reconcile pending revocation after node reconnect",
        );
      else if (row.status !== "ended") {
        const live = liveById.get(row.id);
        if (live?.transportLost) await reconnectSalaam(live);
        else if (!live) await restoreSalaamRow(row);
      }
    }
}

function proxyOptions(live: LiveSession): OpenAcpWireOptions {
  return {
    ...(live.mcpProxyRequested
      ? { mcpProxy: { stationId: live.stationId } }
      : {}),
    ...(live.executionAuthority
      ? { salaamAuthority: live.executionAuthority.binding }
      : {}),
  };
}

/** The names the node's proxy gives its two servers (node-agent internal/mcpproxy). */
const PROXIED_HUB = "agentpod";
const PROXIED_SUPERLIBRARY = "superlibrary";

/**
 * Does this live session carry BOTH the hub's MCP server and Superlibrary's, through its node's
 * proxy? The card prompt names `agentpod_link_artifact` and `library_search` on this alone
 * (S3-R12): a prompt naming a tool the session lacks sends the agent into a failing call.
 */
export function sessionHasLibraryTools(sessionId: string): boolean {
  const live = liveById.get(sessionId);
  return (
    !!live &&
    (live.harness !== 'salaam' || live.managedMcpVerified === true) &&
    live.mcpProxied.includes(PROXIED_HUB) &&
    live.mcpProxied.includes(PROXIED_SUPERLIBRARY)
  );
}

/**
 * Send one turn's prompt.
 *
 * `images` are the pictures that came with it — from a bridged room, today.
 * They go to the agent as ACP image blocks when it accepts them, and as a
 * note in the text when it does not. The transcript records each image's
 * name, type and size, never its bytes: `acp_events` is a log, not a store
 * of everything anyone ever sent an agent.
 */
export function promptSession(
  userId: string,
  sessionId: string,
  text: string,
  images?: PromptImage[],
  executionRun?: import("@agentpod/contract").SalaamRunAuthority,
): Promise<void>;
export function promptSession(
  userId: string,
  sessionId: string,
  text: string,
  images: PromptImage[],
  executionRun: import("@agentpod/contract").SalaamRunAuthority | undefined,
  requestId: string | undefined,
): Promise<void | SalaamPromptReceipt>;
export async function promptSession(
  userId: string,
  sessionId: string,
  text: string,
  images: PromptImage[] = [],
  executionRun?: import("@agentpod/contract").SalaamRunAuthority,
  requestId?: string,
): Promise<void | SalaamPromptReceipt> {
  return withStationOpenLock("prompt:" + sessionId, async () => {
    const [row] = await db
      .select()
      .from(acpSessions)
      .where(
        and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)),
      );
    if (!row) throw Error("Session not found");
    if (!row.executionAuthority)
      return dispatchPrompt(userId, sessionId, text, images, executionRun);
    if (images.length) throw Error("Salaam image prompts are not enabled");
    const bound = await bindSalaamPrompt(
      userId,
      sessionId,
      requestId ?? crypto.randomUUID(),
      text,
    );
    const id = bound.receipt.requestId;
    if (["accepted", "completed", "interrupted"].includes(bound.receipt.state))
      return bound.receipt;
    if (!liveById.has(sessionId) && row.status !== "ended")
      await restoreSalaamRow(row);
    const live = requireLive(userId, sessionId);
    if (
      live.logicalPromptInFlight === id ||
      (!bound.fresh && live.status !== "idle")
    )
      return bound.receipt;
    await dispatchPrompt(userId, sessionId, text, [], executionRun, id);
    return getSalaamPrompt(userId, sessionId, id);
  });
}

async function dispatchPrompt(
  userId: string,
  sessionId: string,
  text: string,
  images: PromptImage[] = [],
  executionRun?: import("@agentpod/contract").SalaamRunAuthority,
  requestId?: string,
): Promise<void> {
  const live = requireLive(userId, sessionId);
  if (live.executionAuthority)
    await renewExecution(userId, sessionId, executionRun);
  if (live.status !== "idle") {
    throw new Error(SESSION_BUSY_MESSAGE);
  }
  const agent = live.agent;
  if (!agent) throw new Error("Session is still starting.");

  // The first real prompt names the session, in the user-prompt's own write.
  // COALESCE is what makes "first" mean first: an existing title always wins,
  // so a long conversation keeps the label the user recognises no matter how
  // many prompts follow (and a whitespace-only prompt sets nothing at all).
  const logicalRequestId = requestId ?? crypto.randomUUID();
  const title = deriveSessionTitle(text || images[0]?.name || "");
  const { done: promptWritten } = persistEvent(
    live,
    "user-prompt",
    images.length === 0
      ? {
          text,
          ...(live.executionAuthority ? { requestId: logicalRequestId } : {}),
        }
      : {
          text,
          images: images.map(({ name, mimeType, bytes }) => ({
            name,
            mimeType,
            bytes,
          })),
        },
    title === null
      ? {}
      : { title: sql`COALESCE(${acpSessions.title}, ${title})` },
  );
  const { done: statusWritten } = setStatus(live, "working");
  await Promise.all([promptWritten, statusWritten]);

  // Audit the action, never the prompt text. An audit failure must not strand
  // the session at `working`: revert to idle with an error event and rethrow.
  let audit: Awaited<ReturnType<typeof recordAudit>>;
  try {
    audit = await recordAudit(db, {
      tenantId: live.tenantId,
      userId,
      nodeId: live.nodeId,
      stationKey: live.stationKey,
      verb: "acp.prompt",
      params:
        images.length === 0
          ? { chars: text.length }
          : { chars: text.length, images: images.length },
    });
  } catch (err) {
    persistEvent(
      live,
      "error",
      turnErrorFromReason(
        "Couldn't record the audit entry — prompt aborted.",
        live.harness,
        "hub",
      ),
    );
    await setStatus(live, "idle").done;
    throw err;
  }

  if (live.executionAuthority)
    await updateSalaamPrompt(live.id, logicalRequestId, "dispatched");
  live.logicalPromptInFlight = logicalRequestId;

  // Whether this turn's images can travel. Two things must be true: the agent
  // said at `initialize` that it takes images, and its node reads frames that
  // large. A node from before "frames.large" closes its whole hub connection
  // on any frame over 32 KiB — every station on it, mid-turn — which is what
  // the first image sent to Krishna did (ashram, 2026-09-24).
  let imageRefusal: string | null = null;
  if (images.length > 0) {
    if (!live.acceptsImages) {
      imageRefusal = "this agent cannot view images";
    } else if (!(await nodeReadsLargeFrames(live.nodeId))) {
      imageRefusal =
        "this agent's machine needs an AgentPod update before it can receive images";
    }
  }

  // Stale-turn guard: only the completion of the CURRENT turn may transition
  // status (a late response from a cancelled turn must not reset a new one).
  live.turnEpoch += 1;
  live.turnProduced = false;
  live.turnInFlight = true;
  live.turnErrorRecorded = false;
  live.turnErrorSource = null;
  live.pendingTurnError = null;
  live.pendingTurnErrorAt = 0;
  live.lastProducedAt = 0;
  live.turnResolution = null;
  const epoch = live.turnEpoch;
  const isCurrentTurn = () =>
    !live.ended &&
    live.turnEpoch === epoch &&
    (live.status === "working" ||
      (live.status === "waiting" &&
        live.pendingCancellation?.targetRequestId === logicalRequestId));
  const settled = () => {
    if (live.turnEpoch !== epoch) return;
    live.turnInFlight = false;
    if (live.logicalPromptInFlight === logicalRequestId)
      delete live.logicalPromptInFlight;
    live.lastTurnSettledAt = Date.now();
  };
  const recordError = async (error: TurnError) => {
    if (live.executionAuthority)
      error = {
        ...error,
        failureCode: error.failureCode ?? "execution_interrupted",
        logicalRequestId: logicalRequestId,
        localSessionId: live.executionAuthority.sessionId ?? undefined,
      };
    live.turnErrorRecorded = true;
    live.turnErrorSource = error.source;
    await audit.done("error", error.message).catch(() => {});
    const { done: errorWritten } = persistEvent(live, "error", error);
    const { done: idleWritten } = setStatus(
      live,
      live.pendingCancellation && live.pendingCancellation.state !== "confirmed"
        ? "waiting"
        : "idle",
    );
    await Promise.all([errorWritten, idleWritten]);
  };

  // The turn runs in the background; its completion restores idle. Callers
  // observe progress via subscribe()/acp_events, not this promise.
  agent
    .request("session/prompt", {
      sessionId: live.acpSessionId,
      prompt: promptBlocks(text, images, imageRefusal),
      ...acpTraceMeta(),
      ...(live.executionAuthority
        ? {
            _meta: {
              ...((acpTraceMeta() as { _meta?: object })._meta ?? {}),
              "salaam.dev/requestId": logicalRequestId,
            },
          }
        : {}),
    })
    .then(async (response) => {
      const responseMeta = (response as { _meta?: Record<string, unknown> })
        ._meta;
      const rawFailure = responseMeta?.["salaam.dev/failure"];
      const parsedFailure = rawFailure
        ? SalaamAcpFailure.safeParse(rawFailure)
        : null;
      if (rawFailure && !parsedFailure?.success)
        throw Error("Salaam returned malformed typed failure metadata");
      if (
        parsedFailure?.success &&
        (parsedFailure.data.requestId !== logicalRequestId ||
          parsedFailure.data.sessionId !== live.executionAuthority?.sessionId)
      )
        throw Error("Salaam failure belongs to another instruction");
      if (live.executionAuthority) {
        const metadata = (response as { _meta?: Record<string, unknown> })
          ._meta;
        const terminal = SalaamPromptReceipt.parse({
          sessionId: live.id,
          requestId: metadata?.["salaam.dev/requestId"],
          attemptId: metadata?.["salaam.dev/attemptId"],
          state:
            (response as { stopReason?: string }).stopReason === "end_turn" &&
            !parsedFailure?.success
              ? "completed"
              : "interrupted",
        });
        if (terminal.requestId !== logicalRequestId || !terminal.attemptId)
          throw Error(
            "Salaam returned a receipt for a different logical instruction",
          );
        await updateSalaamPrompt(
          live.id,
          logicalRequestId,
          terminal.state,
          terminal.attemptId,
        );
      }
      const stopReason = (response as { stopReason?: unknown })?.stopReason;
      if (
        parsedFailure?.success ||
        ["max_tokens", "refusal", "cancelled"].includes(String(stopReason)) ||
        (live.executionAuthority && stopReason !== "end_turn")
      ) {
        const error = parsedFailure?.success
          ? turnErrorFromRejection(
              { data: { "salaam.dev/failure": parsedFailure.data } },
              live.harness,
            )
          : turnErrorForSilentTurn(live.harness, stopReason);
        if (isCurrentTurn()) await recordError(error);
        else await audit.done("error", error.message);
        settled();
        return;
      }
      if (isCurrentTurn()) {
        // A plugin already said why, during the turn — unless the agent spoke
        // after that report. OpenClaw's plugin reports a failed model once its
        // attempts go quiet, and the next model in the chain can still answer
        // (krishna, 2026-09-26 08:09: Kimi's quota, then a fallback's "Hey
        // Rakesh"). Words after the report mean the chain recovered; a report
        // after the last words (a partial answer, or Pi reporting at settled
        // after "Retrying…") is the turn's error.
        if (
          live.pendingTurnError &&
          live.lastProducedAt > live.pendingTurnErrorAt
        ) {
          log.info(
            "a plugin's turn error was followed by an answer; the fallback recovered",
            {
              sessionId: live.id,
              kind: live.pendingTurnError.kind,
            },
          );
          live.pendingTurnError = null;
        }
        if (live.pendingTurnError) {
          await recordError(live.pendingTurnError);
          settled();
          return;
        }
        if (!live.turnProduced) {
          // Nothing came back. A harness that drops its errors over ACP may
          // have a plugin about to say why; give it a moment — unless its
          // plugin has already said the run ended well.
          const reported = live.turnResolution ?? (await awaitTurnError(live));
          if (!isCurrentTurn()) {
            settled();
            return;
          }
          if (reported === "answered" || reported === "silent") {
            // The agent chose to say nothing (NO_REPLY). An empty turn it
            // chose is not a failed one: no error, and the room says done.
            await audit.done("ok");
            await setStatus(live, "idle", { extra: { silent: true } }).done;
            settled();
            return;
          }
          await recordError(
            reported ??
              turnErrorForSilentTurn(
                live.harness,
                (response as { stopReason?: unknown } | undefined)?.stopReason,
              ),
          );
          settled();
          return;
        }
        await audit.done("ok");
        await setStatus(live, "idle").done;
      } else {
        await audit.done("ok");
      }
      settled();
    })
    .catch(async (err) => {
      const typed = SalaamAcpFailure.safeParse(
        (err as { data?: Record<string, unknown> })?.data?.[
          "salaam.dev/failure"
        ],
      );
      const correlated =
        typed.success &&
        typed.data.sessionId === live.executionAuthority?.sessionId &&
        typed.data.requestId === logicalRequestId;
      if (live.executionAuthority)
        await updateSalaamPrompt(
          live.id,
          logicalRequestId,
          correlated ? "interrupted" : "unknown",
          correlated ? typed.data.attemptId : undefined,
        ).catch(() => {});
      if (
        live.executionAuthority &&
        !live.ended &&
        (live.transportLost || !connectionManager.isOnline(live.nodeId))
      ) {
        // The accepted prompt belongs to the daemon. Inspect it; never resubmit it.
        const deadline = Date.now() + 90_000;
        while (!live.ended && Date.now() < deadline) {
          if (connectionManager.isOnline(live.nodeId)) {
            try {
              const status = await inspectSalaamExecution(
                live.executionAuthority,
              );
              if (status.revoked) break;
              if (status.interrupted_attempts.length) {
                await recordError(
                  turnErrorFromReason(
                    "Salaam attempt interrupted; explicit continuation required",
                    "salaam",
                    "hub",
                  ),
                );
                settled();
                return;
              }
              if (!status.active_attempts.length) {
                const recovered = await getSalaamPrompt(
                  live.userId,
                  live.id,
                  logicalRequestId,
                );
                if (["completed", "interrupted"].includes(recovered.state)) {
                  await audit.done(
                    recovered.state === "completed" ? "ok" : "error",
                    recovered.state === "completed"
                      ? undefined
                      : "Saved instruction was interrupted or cancelled",
                  );
                  await setStatus(
                    live,
                    live.pendingCancellation &&
                      live.pendingCancellation.state !== "confirmed"
                      ? "waiting"
                      : "idle",
                  ).done;
                  settled();
                  return;
                }
                // Absence of an active process alone is not a terminal outcome.
              }
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      // The harness's words, with what it put in `data` — Codex's quota
      // sentence is only there — classified into one shape for every reader.
      let error = turnErrorFromRejection(err, live.harness);
      if (live.executionAuthority)
        error =
          typed.success && !correlated
            ? {
                message:
                  "Salaam returned failure metadata for another instruction",
                kind: "unknown",
                harness: "salaam",
                source: "acp-rejection",
                failureCode: "failure_correlation",
                logicalRequestId,
                localSessionId: live.executionAuthority.sessionId ?? undefined,
              }
            : {
                ...error,
                failureCode: error.failureCode ?? "execution_interrupted",
                logicalRequestId,
                localSessionId: live.executionAuthority.sessionId ?? undefined,
              };
      // …and when it gave us no words at all, go and find out why.
      //
      // A bare JSON-RPC generic is not a failure any amount of text matching can
      // classify. It is also exactly what a harness sends when the thing it talks
      // THROUGH has gone away but its own process has not: observed on 2026-10-03,
      // when an agent restarted the OpenClaw gateway hosting its own session and
      // three prompts in a row came back as "Internal error". `pgrep` said the
      // gateway was running the whole time, so nothing short of a dial could tell.
      //
      // One question, only when we learned nothing, and only an explicit "not
      // reachable" is allowed to replace the harness's own error — see
      // `gatewayUnreachable` for why the asymmetry matters.
      if (rejectionSaidNothing(err)) {
        const probe = await broker.request(live.nodeId, "acp.transport", {
          key: live.stationKey,
        });
        if (probe.ok && gatewayUnreachable(probe.data)) {
          error = turnErrorForUnreachableGateway(live.harness);
          // Background, deliberately: the reader already has their answer, and the
          // session quietly becomes usable again behind it.
          void reattachAfterTransportLoss(live);
        }
      }
      await audit.done("error", error.message).catch(() => {});
      // Wire-level failures transition the session via handleWireClosed; only
      // recover to idle when this turn is still the live one. A normal ACP
      // request rejection is different: persist it in the transcript so every
      // client sees the provider or adapter error instead of an idle empty turn.
      if (isCurrentTurn()) {
        // A plugin's report knows the provider and the fallback chain; the
        // rejection, when both exist, is the less specific of the two.
        const recorded = live.pendingTurnError ?? error;
        live.turnErrorRecorded = true;
        live.turnErrorSource = recorded.source;
        const { done: errorWritten } = persistEvent(live, "error", recorded);
        const { done: idleWritten } = setStatus(
          live,
          live.pendingCancellation &&
            live.pendingCancellation.state !== "confirmed"
            ? "waiting"
            : "idle",
        );
        await Promise.all([errorWritten, idleWritten]);
        settled();
        return;
      }
      // A node that dropped rejects its prompt at once, while the session
      // waits at `waiting` for it to come back. That turn is not over — it is
      // lost, and finalizeEnd records why if the node never returns.
      if (!live.ended && live.turnEpoch === epoch && live.status === "waiting")
        return;
      settled();
    });
}

/** Wait, up to the grace window, for a plugin to report this turn's error. */
function awaitTurnError(
  live: LiveSession,
): Promise<TurnError | TurnResolution | null> {
  if (turnErrorGraceMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      live.awaitingTurnError = null;
      resolve(null);
    }, turnErrorGraceMs);
    timer.unref?.();
    live.awaitingTurnError = (error) => {
      clearTimeout(timer);
      live.awaitingTurnError = null;
      resolve(error);
    };
  });
}

export type TurnErrorReportOutcome =
  | "awaited"
  | "pending"
  | "merged"
  | "resolved"
  | "late"
  | "duplicate"
  | "unmatched";

/**
 * One turn's reports, as one error. The first report leads — it is about the
 * model the agent was asked to use, and the rest are its fallbacks failing in
 * turn — and every attempt is kept, in order.
 */
function mergeTurnErrors(first: TurnError, next: TurnError): TurnError {
  const attemptsOf = (e: TurnError) =>
    e.attempts ?? [
      {
        provider: e.provider ?? "unknown",
        model: e.model ?? "unknown",
        kind: e.kind,
        message: e.message,
        ...(e.providerErrorType
          ? { providerErrorType: e.providerErrorType }
          : {}),
      },
    ];
  return { ...first, attempts: [...attemptsOf(first), ...attemptsOf(next)] };
}

/**
 * A harness plugin's report of a failed turn, forwarded by the node it runs on.
 *
 * Only that node's sessions are candidates: anyone who can send a turn.error
 * can put words in a room, and a node speaks only for what it runs.
 */
export function reportTurnError(
  nodeId: string,
  report: TurnErrorReport,
): TurnErrorReportOutcome {
  const candidates = [...liveById.values()].filter(
    (live) =>
      !live.ended &&
      live.nodeId === nodeId &&
      (report.acpSessionId !== undefined
        ? live.id === report.acpSessionId
        : live.harnessSessionKey === report.harnessSessionKey),
  );
  // One harness session can be open from two places (a room and the console);
  // the report is about the one that is failing now.
  const live =
    candidates.find((c) => c.awaitingTurnError) ??
    candidates.find((c) => c.turnInFlight) ??
    candidates.sort((a, b) => b.lastTurnSettledAt - a.lastTurnSettledAt)[0];

  if (!live) {
    // Info, not warn: a plugin sees every channel its harness serves, and a
    // failed turn in a Telegram chat has no hub session to belong to.
    log.info("a turn error was reported for no live session on its node", {
      nodeId,
      acpSessionId: report.acpSessionId,
      harnessSessionKey: report.harnessSessionKey,
    });
    return "unmatched";
  }

  if (report.resolution) {
    // The run this plugin reported (or is watching) ended well: whatever it
    // said failed was recovered. A pending report goes; a waiting turn wakes.
    live.pendingTurnError = null;
    live.pendingTurnErrorAt = 0;
    if (live.awaitingTurnError) {
      live.awaitingTurnError(report.resolution);
      return "resolved";
    }
    if (live.turnInFlight) {
      live.turnResolution = report.resolution;
      return "resolved";
    }
    // Too late to take back what the room was already told.
    log.info("a turn resolution arrived after its turn ended", {
      nodeId,
      sessionId: live.id,
      resolution: report.resolution,
    });
    return "late";
  }
  if (!report.error) return "unmatched";
  const error = turnErrorFromPlugin(report.error, live.harness);
  if (live.awaitingTurnError) {
    live.awaitingTurnError(error);
    return "awaited";
  }
  if (live.turnInFlight && !live.turnErrorRecorded) {
    // More than one report for a turn: merge, never replace. Replacing lost
    // Kimi's quota — the cause — behind the fallbacks' errors (2026-09-26).
    live.pendingTurnErrorAt = Date.now();
    if (live.pendingTurnError) {
      live.pendingTurnError = mergeTurnErrors(live.pendingTurnError, error);
      return "merged";
    }
    live.pendingTurnError = error;
    return "pending";
  }
  if (live.turnErrorSource === "plugin") {
    // The room already shows a plugin's account of this turn. Another would be
    // the same news twice, which is exactly what krishna's room showed.
    return "duplicate";
  }
  if (Date.now() - live.lastTurnSettledAt < LATE_TURN_ERROR_MS) {
    // The turn already has its error ("completed without a reply"). This one
    // says why, so it follows rather than being lost.
    live.turnErrorSource = error.source;
    persistEvent(live, "error", error);
    return "late";
  }
  log.warn("a turn error was reported too long after its turn to place", {
    nodeId,
    sessionId: live.id,
  });
  return "unmatched";
}

export async function cancelTurn(
  userId: string,
  sessionId: string,
): Promise<void> {
  const bound = liveById.get(sessionId);
  if (bound?.executionAuthority)
    return withStationOpenLock("prompt:" + sessionId, async () => {
      const live = requireLive(userId, sessionId);
      const saved = await readSalaamCancellation(live.id);
      let target =
        saved && saved.state !== "confirmed"
          ? saved.targetRequestId
          : live.logicalPromptInFlight;
      if (!target) {
        const pending = await db
          .select({ requestId: acpPromptRequests.requestId })
          .from(acpPromptRequests)
          .where(
            and(
              eq(acpPromptRequests.sessionId, live.id),
              inArray(acpPromptRequests.state, [
                "prepared",
                "dispatched",
                "accepted",
                "unknown",
              ]),
            ),
          )
          .limit(2);
        if (pending.length > 1)
          throw Error(
            "Multiple pending instructions require explicit session revocation",
          );
        target = pending[0]?.requestId;
      }
      if (!target) return;
      if (
        saved &&
        saved.state !== "confirmed" &&
        live.logicalPromptInFlight &&
        live.logicalPromptInFlight !== target
      )
        throw Error(
          "Reconcile the previous cancellation before cancelling another instruction",
        );
      const intent: SalaamCancellationState =
        saved && saved.state !== "confirmed"
          ? saved
          : {
              requestId: crypto.randomUUID(),
              targetRequestId: target,
              state: "requested",
              source: "hub-intent",
            };
      live.pendingCancellation = intent;
      rejectPendingPermissions(live);
      if (intent !== saved)
        await setStatus(live, live.turnInFlight ? "working" : "waiting", {
          extra: { cancellation: intent },
          force: true,
        }).done;
      await salaamCancelBeforeNotifyForTest?.();
      await resendSalaamCancellation(live);
    });
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

let salaamCancelBeforeNotifyForTest: (() => Promise<void>) | undefined;
export function _setSalaamCancelBeforeNotifyForTest(
  hook?: () => Promise<void>,
): void {
  salaamCancelBeforeNotifyForTest = hook;
}
async function resendSalaamCancellation(live: LiveSession): Promise<void> {
  const intent = live.pendingCancellation;
  if (!intent || intent.state === "confirmed" || !live.agent) return;
  await live.agent
    .notify("session/cancel", {
      sessionId: live.acpSessionId,
      _meta: {
        "salaam.dev/cancellationId": intent.requestId,
        "salaam.dev/targetRequestId": intent.targetRequestId,
      },
    })
    .catch(() => {});
}

export async function answerPermission(
  userId: string,
  sessionId: string,
  requestSeq: number,
  optionId: string,
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
  mode: AcpSessionMode,
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
  reason: string,
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
  if (rows[0].executionAuthority)
    await revokeSalaamExecution(sessionId, reason);
  if (rows[0].status === "ended") return;
  await appendEndedState(sessionId, reason);
}

/**
 * A workspace owner/admin ends someone else's session (spec: session lifecycle, 2026-10-23):
 * the same end and confirmed revocation as the owner's own, with `endedCause: "admin"` on the row.
 * The caller decides the role and writes the audit entry; this checks only that the session is in
 * the caller's workspace. Returns the ended row's owner and station, or null when not found.
 */
export async function endSessionAsWorkspaceAdmin(
  tenantId: string,
  sessionId: string,
  reason: string,
): Promise<{ userId: string; stationId: string } | null> {
  const [row] = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.tenantId, tenantId)));
  if (!row) return null;
  const live = liveById.get(sessionId);
  if (live) await finalizeEnd(live, reason, "admin");
  else {
    if (row.executionAuthority) await revokeSalaamExecution(sessionId, reason);
    if (row.status !== "ended") await appendEndedState(sessionId, reason, "admin");
  }
  return { userId: row.userId, stationId: row.stationId };
}

/**
 * Append a state-ended event (seq = MAX(seq)+1) and mark a NON-LIVE row ended.
 * Live sessions go through finalizeEnd instead (in-memory seq counter).
 */
async function appendEndedState(
  sessionId: string,
  reason: string,
  cause?: "idle" | "admin",
): Promise<void> {
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
      ...(cause ? { endedCause: cause } : {}),
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
  scope?: { userId: string; stationId: string },
): Promise<Array<{ seq: number; type: string; payload: unknown }>> {
  // Doors must bind an opaque session ID to the authenticated caller and the
  // station selected by its proxy. A session ID alone is never read authority.
  if (scope) {
    const session = await getSession(scope.userId, sessionId);
    if (!session || session.stationId !== scope.stationId)
      throw Error("Session not found");
  }
  const rows = await db
    .select({
      seq: acpEvents.seq,
      type: acpEvents.type,
      payload: acpEvents.payload,
    })
    .from(acpEvents)
    .where(and(eq(acpEvents.sessionId, sessionId), gt(acpEvents.seq, sinceSeq)))
    .orderBy(asc(acpEvents.seq));
  return rows as Array<{ seq: number; type: string; payload: unknown }>;
}

/** Subscribe to live events; replay is the caller's job (read acp_events). */
export function subscribe(
  sessionId: string,
  fn: (e: AcpEvent) => void,
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
    if (row.executionAuthority) {
      await restoreSalaamRow(row);
      continue;
    }
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
      log.info(
        "ACP reconcile: node process held by a live session — not closed",
        {
          sessionId: row.id,
          nodeSessionId: row.nodeSessionId,
        },
      );
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
    log.info(
      `ACP reconcile: ended ${stale.length} stale session(s) from before restart`,
    );
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
        isNotNull(acpSessions.nodeSessionId),
      ),
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
  void recoverSalaamForNode(nodeId).catch((err) =>
    log.error("Salaam recovery failed", { nodeId, error: String(err) }),
  );
  closeOrphanedProcesses(nodeId).catch((err) => {
    log.error("ACP orphan cleanup failed", { nodeId, error: String(err) });
  });
});
