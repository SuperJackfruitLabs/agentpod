/**
 * The live sessions this hub holds: their in-memory state (`LiveSession`), the maps that find
 * them by id and by station, and the input a new session is opened from.
 */

import type { ClientConnection, ClientContext, McpServer, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AcpSessionMode, AcpSessionStatus, SalaamRunAuthority, TurnError, TurnResolution } from "@agentpod/contract";
import type { TokenAuthority } from "../../auth/caller-authority";
import type { StoredSalaamExecution } from "../../db/schema/acp";
import type { SalaamCancellationState } from "../salaam";
import type { AcpWire } from "./transport";

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
  executionRun?: SalaamRunAuthority;
  validateExecutionRun?: () => Promise<unknown>;
}

export interface LiveSession {
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
export const liveByStation = new Map<string, Set<LiveSession>>();
export const liveById = new Map<string, LiveSession>();

/** Verbatim copy the routes map to 409 — do not reword (tests pin it). */
export const ACTIVE_SESSION_MESSAGE =
  "An active session already exists for this agent.";

export function addLive(live: LiveSession): void {
  let set = liveByStation.get(live.stationId);
  if (!set) {
    set = new Set();
    liveByStation.set(live.stationId, set);
  }
  set.add(live);
  liveById.set(live.id, live);
}

/** Identity-guarded removal; the station key drops when its last one goes. */
export function removeLive(live: LiveSession): void {
  const set = liveByStation.get(live.stationId);
  if (set) {
    set.delete(live);
    if (set.size === 0) liveByStation.delete(live.stationId);
  }
  if (liveById.get(live.id) === live) liveById.delete(live.id);
}

/** Live sessions on the station other than `self`. */
export function otherLive(stationId: string, self: LiveSession): LiveSession[] {
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
export function isNodeSessionIdLive(nodeId: string, nodeSessionId: string): boolean {
  for (const live of liveById.values()) {
    if (live.nodeId === nodeId && live.nodeSessionId === nodeSessionId) {
      return true;
    }
  }
  return false;
}

/**
 * A fresh live session at `starting`, with nothing open yet. Shared by the first open and by a
 * Salaam restore, so both start from the same state.
 */
export function makeLive(
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

// ─── Live-session lifecycle helpers ──────────────────────────────────────────

export function requireLive(userId: string, sessionId: string): LiveSession {
  const live = liveById.get(sessionId);
  if (!live || live.userId !== userId) {
    throw new Error("Session not found or not active.");
  }
  return live;
}

/** Test seam: forget a live session as a hub restart would, without ending its row. */
/** Test seam: whether a session is held live in this hub process. */
export function _isLiveForTest(sessionId: string): boolean {
  return liveById.has(sessionId);
}
export function _forgetLiveForTest(sessionId: string): void {
  const live = liveById.get(sessionId);
  if (!live) return;
  clearInterval(live.authorityTimer);
  live.ended = true; // this process forgets it; nothing more is written for it
  removeLive(live);
}
