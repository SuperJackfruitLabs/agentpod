/**
 * The fleet's live state, for one reader — and the Lock Screen card it becomes.
 *
 * Pure: a state and an event in, a state and how urgent the change is out;
 * a state and a clock in, the `ContentState` the app decodes out. No I/O, no
 * timers, no module state — `service.ts` is the thin shell that feeds this
 * from `outbound.ts`, `permissions.ts` and `gates.ts` and turns its output
 * into APNs pushes. Spec A2/A4 (supermessage
 * `docs/superpowers/specs/2026-09-29-fleet-live-activity-and-recap-widgets-design.md`).
 *
 * **What this builds reaches Apple in plaintext** — agent names, step titles,
 * decision questions and option labels — by operator decision 2026-09-29.
 * Bounded here, never trusted to be short.
 */

import {
  FLEET_AGENTS_MAX,
  FLEET_DECISION_OPTIONS_MAX,
  FLEET_QUESTION_MAX,
  FLEET_STEP_MAX,
  type FleetLiveAgent,
  type FleetLiveAgentState,
  type FleetContentState,
  type FleetLiveDecision,
  type FleetLiveDecisionOption,
  type FleetLivePhase,
} from "@agentpod/contract";

/**
 * The roster's rule for "active" (supermessage `core::roster::ACTIVE_WITHIN_MS`):
 * an agent that did something within the last 15 minutes.
 */
export const ACTIVE_WITHIN_MS = 15 * 60 * 1000;
/**
 * A turn nothing has been heard from in an hour is not shown as working any
 * more. The hub can lose a turn's end (a session dropped without `idle`), and
 * without this one lost end would hold the Lock Screen card up for good.
 */
export const TURN_SILENT_MAX_MS = 60 * 60 * 1000;
/** Not a contract bound — the app truncates visually — but it keeps a push well inside 4 KB. */
export const NAME_MAX = 40;
/** A button's text. */
export const OPTION_LABEL_MAX = 24;
/** An option is answered by its id, so an id is never cut — one this long is dropped. */
export const OPTION_ID_MAX = 64;

export const WAITING_FOR_YOU = "Waiting for you";

// ─── The state ───────────────────────────────────────────────────────────────

export interface TurnProgress {
  startedAt: number;
  /**
   * Where the turn is on the card's track (spec 2026-09-30 A1): `thinking`
   * from its start and after a thought, `tools` after a tool update,
   * `writing` once answer text streams. The last of them wins; a permission
   * ask leaves it as it was.
   */
  phase: FleetLivePhase;
  step?: string;
  completed: number;
  total: number;
}

export interface TurnOutcome {
  kind: "done" | "failed";
  /** For a failed turn, the step it failed at. */
  completed: number;
  total: number;
  /** When the turn started (its finish, when its start was never heard) and finished — "Done in 3m 57s". */
  startedAt: number;
  endedAt: number;
}

export interface AgentRecord {
  roomId: string;
  /** The agent's Matrix id, which the app keys its cached avatar by. */
  mxid?: string;
  name: string;
  /** The running turn, or null between turns. */
  turn: TurnProgress | null;
  lastActivityAt: number;
  /** How the last turn ended, until the next one starts. Null for a turn that only talked. */
  outcome: TurnOutcome | null;
}

export interface DecisionRecord {
  /** `perm:<roomId>` for a permission (one per room at a time), `gate:<gateId>` for a gate. */
  key: string;
  roomId: string;
  eventId: string;
  agent: string;
  kind: "permission" | "gate";
  question: string;
  options: FleetLiveDecisionOption[];
  askedAt: number;
  /** A gate's board, so a sweep of that board can clear the gates it no longer lists. */
  boardId?: string;
}

export interface FleetState {
  /** Keyed by the agent's room. */
  readonly agents: ReadonlyMap<string, AgentRecord>;
  /** Keyed by `DecisionRecord.key`. */
  readonly decisions: ReadonlyMap<string, DecisionRecord>;
}

export function emptyFleet(): FleetState {
  return { agents: new Map(), decisions: new Map() };
}

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * Times are epoch milliseconds. `mxid` is the agent's Matrix id; every
 * producer knows it, and an event without one keeps the one already known.
 */
export type FleetEvent =
  /** The session went `working`. After a permission pause it is the same turn. */
  | { type: "turn-started"; roomId: string; mxid?: string; name: string; at: number }
  /** A tool call started or changed. `completed`/`total` are this turn's tool counts so far. */
  | {
      type: "step";
      roomId: string;
      mxid?: string;
      name: string;
      title: string;
      completed: number;
      total: number;
      at: number;
    }
  /** The agent is thinking (a thought chunk). Starts a turn if none is running. */
  | { type: "thinking"; roomId: string; mxid?: string; name: string; at: number }
  /** The agent is writing its answer. Starts a turn if none is running (an unprompted agent). */
  | { type: "spoke"; roomId: string; mxid?: string; name: string; at: number }
  /**
   * The turn ended. `total`/`failed` are the tool counts `recordTurn` wrote;
   * `failedAt` is the 1-based position of the first failed tool; `errored`
   * is a turn whose harness reported an error.
   */
  | {
      type: "turn-finished";
      roomId: string;
      mxid?: string;
      name: string;
      total: number;
      failed: number;
      failedAt?: number;
      errored?: boolean;
      at: number;
    }
  | { type: "decision-asked"; decision: DecisionRecord }
  | { type: "decision-cleared"; key: string };

/**
 * How a change should reach the phone (spec A2):
 * - `none`: nothing visible changed;
 * - `routine`: coalesced, priority 5;
 * - `flush`: at once, priority 5 (a decision clearing);
 * - `important`: at once, priority 10 (a decision arriving, a turn finishing).
 */
export type FleetChange = "none" | "routine" | "flush" | "important";

export function applyFleetEvent(state: FleetState, event: FleetEvent): { state: FleetState; change: FleetChange } {
  switch (event.type) {
    case "turn-started":
    case "thinking":
    case "spoke": {
      const prev = state.agents.get(event.roomId);
      const running = prev?.turn ?? null;
      // Working again after a permission pause is the same turn, in the phase it was.
      const phase: FleetLivePhase =
        event.type === "spoke" ? "writing" : event.type === "thinking" ? "thinking" : (running?.phase ?? "thinking");
      const turn = running ? { ...running, phase } : { startedAt: event.at, phase, completed: 0, total: 0 };
      return {
        state: withAgent(state, {
          roomId: event.roomId,
          ...mxidOf(event, prev),
          name: event.name,
          turn,
          lastActivityAt: Math.max(prev?.lastActivityAt ?? 0, event.at),
          outcome: prev?.turn ? prev.outcome : null,
        }),
        change: "routine",
      };
    }
    case "step": {
      const prev = state.agents.get(event.roomId);
      const started = prev?.turn ?? { startedAt: event.at, completed: 0, total: 0 };
      return {
        state: withAgent(state, {
          roomId: event.roomId,
          ...mxidOf(event, prev),
          name: event.name,
          turn: { ...started, phase: "tools", step: event.title, completed: event.completed, total: event.total },
          lastActivityAt: Math.max(prev?.lastActivityAt ?? 0, event.at),
          outcome: prev?.turn ? prev.outcome : null,
        }),
        change: "routine",
      };
    }
    case "turn-finished": {
      const prev = state.agents.get(event.roomId);
      const failed = event.failed > 0 || event.errored === true;
      const span = { startedAt: Math.min(prev?.turn?.startedAt ?? event.at, event.at), endedAt: event.at };
      const outcome: TurnOutcome | null = failed
        ? { kind: "failed", completed: event.failedAt ?? event.total, total: event.total, ...span }
        : event.total > 0
          ? { kind: "done", completed: event.total, total: event.total, ...span }
          : null;
      return {
        state: withAgent(state, {
          roomId: event.roomId,
          ...mxidOf(event, prev),
          name: event.name,
          turn: null,
          lastActivityAt: event.at,
          outcome,
        }),
        change: "important",
      };
    }
    case "decision-asked": {
      const prev = state.decisions.get(event.decision.key);
      if (prev && prev.eventId === event.decision.eventId) return { state, change: "none" };
      const decisions = new Map(state.decisions);
      decisions.set(event.decision.key, event.decision);
      return { state: { ...state, decisions }, change: "important" };
    }
    case "decision-cleared": {
      if (!state.decisions.has(event.key)) return { state, change: "none" };
      const decisions = new Map(state.decisions);
      decisions.delete(event.key);
      return { state: { ...state, decisions }, change: "flush" };
    }
  }
}

function mxidOf(event: { mxid?: string }, prev: AgentRecord | undefined): { mxid?: string } {
  const mxid = event.mxid ?? prev?.mxid;
  return mxid ? { mxid } : {};
}

function withAgent(state: FleetState, agent: AgentRecord): FleetState {
  const agents = new Map(state.agents);
  agents.set(agent.roomId, agent);
  return { ...state, agents };
}

// ─── Reading it ──────────────────────────────────────────────────────────────

function turnIsLive(agent: AgentRecord, now: number): boolean {
  return agent.turn !== null && now - agent.lastActivityAt <= TURN_SILENT_MAX_MS;
}

function awaitsPermission(state: FleetState, roomId: string): boolean {
  return state.decisions.has(`perm:${roomId}`);
}

/** The agent's state as the card shows it, or null when it is not active. */
function agentState(state: FleetState, agent: AgentRecord, now: number): FleetLiveAgentState | null {
  if (awaitsPermission(state, agent.roomId)) return "needs_you";
  if (turnIsLive(agent, now)) return "working";
  if (now - agent.lastActivityAt > ACTIVE_WITHIN_MS) return null;
  return agent.outcome?.kind ?? "active";
}

/** Whether the card should be up: a turn running, or a decision pending. */
export function isFleetActive(state: FleetState, now: number): boolean {
  // Only a running turn or a pending decision keeps the card up (operator,
  // 2026-09-29): an agent that merely spoke in the last fifteen minutes made
  // an "All quiet" card that stayed up for a quarter of an hour. Finished
  // agents are still listed (`agentState`) while the ended card lingers.
  if (state.decisions.size > 0) return true;
  for (const agent of state.agents.values()) if (turnIsLive(agent, now)) return true;
  return false;
}

/**
 * The next moment the card changes by itself — an agent dropping out of the
 * active window, or a silent turn giving up — or null when nothing will.
 */
export function nextExpiry(state: FleetState, now: number): number | null {
  let next: number | null = null;
  for (const agent of state.agents.values()) {
    if (awaitsPermission(state, agent.roomId)) continue;
    const at = turnIsLive(agent, now)
      ? agent.lastActivityAt + TURN_SILENT_MAX_MS + 1
      : agent.lastActivityAt + ACTIVE_WITHIN_MS + 1;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/** Whether the last thing that happened was a turn finishing — the card then lingers two minutes. */
export function endedOnFinish(state: FleetState): boolean {
  let latest: AgentRecord | null = null;
  for (const agent of state.agents.values()) {
    if (!latest || agent.lastActivityAt > latest.lastActivityAt) latest = agent;
  }
  return latest !== null && latest.turn === null && latest.outcome !== null;
}

/** Forget agents that can no longer show, so a long-lived hub does not keep every room it ever saw. */
export function pruneFleet(state: FleetState, now: number): FleetState {
  let changed = false;
  const agents = new Map(state.agents);
  for (const [roomId, agent] of state.agents) {
    if (agentState(state, agent, now) === null) {
      agents.delete(roomId);
      changed = true;
    }
  }
  return changed ? { ...state, agents } : state;
}

const RANK: Record<FleetLiveAgentState, number> = { needs_you: 0, working: 1, active: 2, done: 2, failed: 2 };

const unix = (ms: number) => Math.floor(ms / 1000);

/** The card's content (spec A4), with every bound applied. */
export function contentState(state: FleetState, now: number): FleetContentState {
  const rows: FleetLiveAgent[] = [];
  for (const agent of state.agents.values()) {
    const s = agentState(state, agent, now);
    if (s === null) continue;
    rows.push(row(agent, s));
  }
  // Most recent first: a finished row by when it finished, since its `since` is its start.
  const recency = (r: FleetLiveAgent) => r.endedAt ?? r.since;
  rows.sort((a, b) => RANK[a.state] - RANK[b.state] || recency(b) - recency(a) || a.name.localeCompare(b.name));

  let oldest: DecisionRecord | null = null;
  for (const d of state.decisions.values()) {
    if (!oldest || d.askedAt < oldest.askedAt) oldest = d;
  }

  return {
    agents: rows.slice(0, FLEET_AGENTS_MAX),
    more: Math.max(0, rows.length - FLEET_AGENTS_MAX),
    ...(oldest ? { decision: decision(oldest) } : {}),
    needsYou: state.decisions.size,
    working: rows.filter((r) => r.state === "working").length,
    updatedAt: unix(now),
  };
}

function row(agent: AgentRecord, s: FleetLiveAgentState): FleetLiveAgent {
  // Keys in the order the contract (and its v2 fixture) writes them.
  const base = {
    roomId: agent.roomId,
    ...(agent.mxid ? { mxid: agent.mxid } : {}),
    name: bound(agent.name, NAME_MAX),
    state: s,
  };
  switch (s) {
    case "needs_you":
      return { ...base, step: WAITING_FOR_YOU, since: unix(agent.turn?.startedAt ?? agent.lastActivityAt) };
    case "working": {
      const turn = agent.turn!;
      const step = turn.step ? bound(turn.step, FLEET_STEP_MAX) : "";
      return {
        ...base,
        phase: turn.phase,
        ...(step ? { step } : {}),
        ...(turn.total > 0 ? { completed: turn.completed, total: turn.total } : {}),
        since: unix(turn.startedAt),
      };
    }
    case "failed": {
      const o = agent.outcome!;
      const span = { since: unix(o.startedAt), endedAt: unix(o.endedAt) };
      if (o.total === 0) return { ...base, ...span };
      return {
        ...base,
        step: bound(`Failed at step ${o.completed} of ${o.total}`, FLEET_STEP_MAX),
        completed: o.completed,
        total: o.total,
        ...span,
      };
    }
    case "done": {
      const o = agent.outcome!;
      return { ...base, completed: o.completed, total: o.total, since: unix(o.startedAt), endedAt: unix(o.endedAt) };
    }
    case "active":
      return { ...base, since: unix(agent.lastActivityAt) };
  }
}

function decision(d: DecisionRecord): FleetLiveDecision {
  return {
    roomId: d.roomId,
    eventId: d.eventId,
    agent: bound(d.agent, NAME_MAX),
    kind: d.kind,
    question: bound(d.question, FLEET_QUESTION_MAX),
    options: d.options.slice(0, FLEET_DECISION_OPTIONS_MAX),
  };
}

// ─── Options ─────────────────────────────────────────────────────────────────

function option(id: string, label: string, declines: boolean): FleetLiveDecisionOption | null {
  if (id.length === 0 || id.length > OPTION_ID_MAX) return null;
  return { id, label: bound(label, OPTION_LABEL_MAX), declines };
}

/**
 * A permission's inline answers, as the app answers them: by the option's
 * NAME (supermessage `core::notification::permission_answers`). Allow-once
 * and reject only — **"always" is never offered inline**: a Lock Screen tap
 * must not grant more than its button said.
 */
export function inlinePermissionOptions(options: ReadonlyArray<{ optionId: string; name: string }>): FleetLiveDecisionOption[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const names = options.map((o) => o.name);
  const allow =
    names.find((n) => norm(n) === "allow once") ??
    names.find((n) => norm(n).startsWith("allow") && !norm(n).includes("always"));
  const reject =
    names.find((n) => norm(n) === "reject") ??
    names.find((n) => (norm(n).startsWith("reject") || norm(n).startsWith("deny")) && !norm(n).includes("always"));
  return [allow ? option(allow, allow, false) : null, reject ? option(reject, reject, true) : null].filter(
    (o): o is FleetLiveDecisionOption => o !== null
  );
}

/** A gate's inline answers: approve and reject. Request changes needs words, so it needs the app. */
export function inlineGateOptions(options: ReadonlyArray<{ id: string; label: string }>): FleetLiveDecisionOption[] {
  const out: FleetLiveDecisionOption[] = [];
  for (const id of ["approve", "reject"] as const) {
    const o = options.find((x) => x.id === id);
    if (!o) continue;
    const made = option(o.id, o.label || (id === "approve" ? "Approve" : "Reject"), id !== "approve");
    if (made) out.push(made);
  }
  return out;
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** One line, at most `max` characters (code points), cut with an ellipsis. */
export function bound(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  const cps = [...line];
  if (cps.length <= max) return line;
  return `${cps.slice(0, max - 1).join("").trimEnd()}…`;
}
