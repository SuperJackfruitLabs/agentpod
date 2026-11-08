/**
 * What a dispatch is given and what it answers: the ACP port, the dependencies, the result, and
 * the defaults and internal shapes the turn shares. Split out of dispatch.ts, unchanged.
 */

import type { AcpEvent, AcpMcpServer, AcpSessionMode, CardPromptRelated, SalaamRunAuthority } from "@agentpod/contract";
import type { infer as Infer } from "zod";
import type { SalaamWorkCompletion } from "../../../../../packages/contract/src/salaam-work-completion";
import type { SalaamPublication } from "./salaam-publish";
import type { Fingerprint } from "../evidence";
import type { BridgeAgentConfig } from "./config";
import type { SuperpipelineClient } from "./superpipeline";

/** Whether a station must run strict Salaam work, and on which protocol version. */
export interface StrictWorkSelection {
  required: boolean;
  version: 1 | null;
  reason?: string;
}

/**
 * The slice of the hub's ACP session machinery a dispatch needs.
 *
 * An interface rather than a direct import so a test can script a turn without
 * a station — the same seam `acp-agent.ts` already uses for Doors.
 */
export interface AcpPort {
  /** Fresh private probe; unsupported Salaam never falls back to generic ACP. */
  strictWork?(input: { stationId: string; tenantId: string; userId: string }): Promise<StrictWorkSelection>;

  /**
   * Could a session be opened on this station right now? Asked BEFORE a claim,
   * because a claim the bridge cannot execute strands a card on the board.
   */
  stationReady(input: { stationId: string; tenantId: string; userId: string }): Promise<{ ready: boolean; reason?: string }>;
  /**
   * `mcpProxy` asks the station's node to add its loopback MCP proxy — the hub's MCP server and
   * Superlibrary's, reached as the station's own agent — to the session. `libraryTools` in the
   * answer is true only when the node said it injected both; the card prompt names their tools
   * on that alone.
   */
  createSession(input: {
    stationId: string;
    /** The workspace the agent's station is in; the session opens only there (W4). */
    tenantId: string;
    userId: string;
    mode: AcpSessionMode;
    mcpServers?: AcpMcpServer[];
    mcpProxy?: boolean;
    executionRun?: SalaamRunAuthority;
    validateExecutionRun?: () => Promise<unknown>;
  }): Promise<{ id: string; libraryTools?: boolean }>;
  promptSession(userId: string, sessionId: string, text: string, run?: SalaamRunAuthority): Promise<void>;
  renewExecution?(userId: string, sessionId: string, run: SalaamRunAuthority): Promise<void>;
  /** Before a strict re-drive: restore a session a hub restart left un-held; "waiting" while its node is offline. */
  ensureStrictSession?(userId: string, sessionId: string): Promise<"live" | "waiting" | "gone">;
  subscribe(sessionId: string, fn: (e: AcpEvent) => void): () => void;
  endSession(userId: string, sessionId: string, reason: string): Promise<void>;
  /**
   * Deliver a decision to the harness parked on `requestSeq`.
   *
   * `optionId` is ACP's own identifier for the option, and it is delivered
   * verbatim: an allow option allows, a reject option rejects. Nothing here
   * interprets which is which, because a bridge that decided what a human's
   * choice "really meant" is the failure this whole path exists to avoid.
   */
  answerPermission(
    userId: string,
    sessionId: string,
    requestSeq: number,
    optionId: string,
    answeredBy?: { via: "board"; principalId: string | null; userId: string | null },
  ): Promise<void>;
}

export interface DispatchDeps {
  /** Test seam: settle a stopped strict run with its known effects preserved, only once Salaam's
   * status says it can prove them; throws otherwise. Defaults to salaam-dispatch's settlement. */
  settleStoppedWork?: (runId: string) => Promise<void>;
  /** How long a parked run waits before its settlement is offered again (default 10 min). */
  settlementRetryMs?: number;
  client: SuperpipelineClient;
  acp: AcpPort;
  agent: BridgeAgentConfig;
  tenantId: string;
  source: string;
  /** Strict Salaam publication; tests replace it, production uses livePublisher. */
  salaamPublish?: (completion: Infer<typeof SalaamWorkCompletion>) => Promise<SalaamPublication>;
  heartbeatMs?: number;
  turnTimeoutMs?: number;
  /** Overrides the agent's own `permissionWaitMs`. A test seam. */
  permissionWaitMs?: number;
  /** How often the run is re-read while a question is outstanding. */
  permissionPollMs?: number;
  /**
   * Aborted when this agent's loop is being rebuilt from an edited roster row. A strict Salaam
   * driver then hands its run over at its next safe point (between observations, with no renewal
   * in flight) and leaves the durable owner intact, so the rebuilt loop resumes the same run with
   * the new configuration (#776). The old loop's credential is pinned to the old row revision and
   * could no longer publish or answer anything for it.
   */
  handover?: AbortSignal;
  /**
   * superpipeline's MCP endpoint, for the agent's own board tools. Together with
   * the agent's `mcpToken` it is what makes a harness able to report for
   * itself; either one missing means it cannot, and is told nothing about it.
   */
  mcpUrl?: string;
  /**
   * What executed the attempt (contract C3). A seam so a test can state one; defaults to
   * `resolveStationFingerprint`. Bounded by `fingerprintWithin`, so a slow or failing resolver
   * opens the attempt with the all-unknown fingerprint instead of holding the turn. It is awaited
   * inside the serial post queue, so board posts may lag by up to `FINGERPRINT_TIMEOUT_MS`; the
   * ACP turn itself is never held.
   *
   * The one lookup that can come before the turn is `relatedWork`'s, and only when related work is
   * on (Superlibrary configured and the board's switch on): then the occupant lookup (`within`,
   * up to `FINGERPRINT_TIMEOUT_MS`, 2 s) and the related call share `RELATED_TIMEOUT_MS`, so the
   * worst-case delay before the session opens is 2.5 s, not 2 s + 2.5 s. With related work off or
   * unconfigured nothing is awaited before the session beyond the switch read.
   */
  fingerprint?: (input: { tenantId: string; stationId: string }) => Promise<Fingerprint>;
  /** Who the station runs as (contract C5). A seam; defaults to `resolveStationOccupant`, bounded by `within`. */
  occupant?: (input: { tenantId: string; stationId: string }) => Promise<string | null>;
  /**
   * Superlibrary's related prior work for the card, as the station's agent may see it. A seam;
   * defaults to `fetchRelatedWork`, which answers `undefined` whenever the section should be left
   * out (Superlibrary unconfigured, the board switched off, no principal, any failure or lateness).
   */
  relatedWork?: (input: {
    tenantId: string;
    boardId: string;
    cardId: string;
    /** A lookup, awaited only if related work will actually be fetched. */
    principal: string | null | (() => Promise<string | null>);
    enabled?: () => Promise<boolean>;
  }) => Promise<CardPromptRelated[] | undefined>;
  /** Starts minting the agent's Superlibrary token. A seam; defaults to `prefetchRelatedWork`. Fire-and-forget. */
  prefetchRelated?: (input: {
    tenantId: string;
    boardId: string;
    cardId: string;
    principal: string | null | (() => Promise<string | null>);
    enabled?: () => Promise<boolean>;
  }) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export type DispatchStatus =
  /** Nothing to claim (or the board is over budget, or we are at capacity). */
  | "idle"
  /** The station cannot run work, so NOTHING was claimed. No card was touched. */
  | "not-ready"
  /** Claimed, never started, handed straight back. The card is claimable again. */
  | "released"
  /** A prior run's output was reported; the harness was not started. */
  | "replayed"
  /** Worked and reported. */
  | "reported"
  /**
   * Worked, and the AGENT told the board — the bridge's own report arrived
   * second and was refused. Its own status rather than a flavour of `reported`,
   * because the two differ in who authored the card's outcome, and that is the
   * fact an operator reading the ledger is trying to establish.
   */
  | "self-reported"
  /** Worked; the board could not be told. Recoverable — the output is recorded. */
  | "unreported"
  /** The lease lapsed mid-run. The harness was stopped. */
  | "lease-superseded"
  /** The run belongs to another agent. A bug: the loop must not continue. */
  | "foreign-run"
  /**
   * A question was asked and no answer came back that could be delivered —
   * nobody answered in time, the question was cancelled, or what came back
   * named no option the harness had offered. Its own status rather than a
   * flavour of `failed`, because "a human did not answer" is an operational
   * fact about the board and "the harness broke" is not.
   */
  | "unanswered"
  /** The harness or the session failed. */
  | "failed";

export interface DispatchResult {
  status: DispatchStatus;
  externalRunId?: string;
  attemptId?: string;
  reason?: string;
}

/** superpipeline reclaims at 15 minutes; RQ3 measured 12.3s as the longest silence. */
export const DEFAULT_HEARTBEAT_MS = 60_000;
/** A harness that never yields still has to end somewhere. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
/** How often a run with a question outstanding is re-read. */
export const DEFAULT_PERMISSION_POLL_MS = 10_000;
/** How much of what the agent said rides in the handoff. */
export const SUMMARY_LIMIT = 4_000;

/** Why a turn stopped, as far as the event stream is concerned. */
export type TurnEnd =
  | { kind: "yielded" }
  | { kind: "session-ended"; reason: string }
  | { kind: "lease-superseded" }
  | { kind: "foreign-run" }
  /** The harness is parked on a decision. `event` is the request it is parked on. */
  | { kind: "permission-required"; event: AcpEvent }
  /** A question was asked and no deliverable answer came back. */
  | { kind: "unanswered"; reason: string }
  | { kind: "timeout" };

/** How a question ended. Only `answered` resumes the harness. */
export type PermissionResolution =
  /** `answeredBy`: the board's user id for the person, and their suite principal when linked. */
  | { kind: "answered"; optionId: string; answeredBy?: { boardUserId: string; principalId: string | null } }
  /** superpipeline cancelled it: the run ended, the card moved, or it was superseded. */
  | { kind: "cancelled" }
  /** Answered, but with nothing that maps to an option the harness offered. */
  | { kind: "unmappable" }
  /** The board has no record of the question, so nobody can be asked it. */
  | { kind: "unrecorded" }
  | { kind: "timeout"; waitMs: number }
  /** The lease went while we waited. The abort path owns the outcome. */
  | { kind: "aborted" };
