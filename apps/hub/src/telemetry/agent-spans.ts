/**
 * The standard agent spans (superwitness C1), built from the ACP events the hub already
 * persists. Every harness gets the same shape, whether or not it is instrumented.
 *
 * Content never becomes an attribute. Only allow-listed ACP enums, ids and sequence
 * numbers do. A reader follows `acp.session_id` + `acp.seq_*` into `acp_events` for the
 * words. Unknown enum values become `other`, because a harness can put anything in a
 * "kind" string.
 *
 * Parents are passed in explicitly. Nothing here relies on async context surviving an
 * `await` (ws1 A1).
 */
import { SpanStatusCode, trace, type Attributes, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { TurnErrorKind, type AcpEvent } from "@agentpod/contract";

const TOOL_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
const OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const TERMINAL = new Set(["completed", "failed"]);
const MAX_BUFFERED = 1_000;
const MAX_OPEN_CHILDREN = 1_000;

export interface AttemptFacts {
  attemptId: string;
  sessionId: string;
  startSeq: number;
  fingerprintDigest: string;
  harnessName: string;
}

export interface AgentSpanRecorderInit {
  tracer: Tracer;
  parent: Context;
  stationId: string;
  runId?: string;
  onOpen?: (facts: AttemptFacts) => void;
  maxBuffered?: number;
}

const enumOr = (allowed: Set<string>, v: unknown, fallback: string): string =>
  typeof v === "string" && allowed.has(v) ? v : fallback;
const timeOf = (e: AcpEvent): Date => {
  const d = new Date(e.createdAt);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

export class AgentSpanRecorder {
  private attempt: { span: Span; ctx: Context; facts: AttemptFacts } | null = null;
  private buffered: AcpEvent[] = [];
  private turn: { span: Span; ctx: Context; seqFrom: number } | null = null;
  private readonly tools = new Map<string, { span: Span; status: string }>();
  private readonly permissions = new Map<number, { span: Span; optionKinds: Map<string, string> }>();
  private lastSeq = 0;
  private ended = false;
  /** Events that arrived before the attempt opened and did not fit the buffer. */
  droppedEvents = 0;

  constructor(private readonly init: AgentSpanRecorderInit) {}

  onEvent(e: AcpEvent): void {
    if (this.ended) return;
    if (!this.attempt) {
      if (this.buffered.length < (this.init.maxBuffered ?? MAX_BUFFERED)) this.buffered.push(e);
      else this.droppedEvents++;
      return;
    }
    this.apply(e);
  }

  openAttempt(facts: AttemptFacts): void {
    if (this.attempt || this.ended) return;
    const first = this.buffered[0];
    const span = this.init.tracer.startSpan(
      "attempt",
      {
        startTime: first ? timeOf(first) : new Date(),
        attributes: {
          ...this.common(facts),
          "harness.name": facts.harnessName,
          "acp.session_id": facts.sessionId,
          "acp.seq_from": facts.startSeq,
        },
      },
      this.init.parent,
    );
    this.attempt = { span, ctx: trace.setSpan(this.init.parent, span), facts };
    this.init.onOpen?.(facts);
    const pending = this.buffered;
    this.buffered = [];
    for (const e of pending) this.apply(e);
  }

  end(state: string): void {
    if (this.ended) return;
    this.ended = true;
    this.buffered = [];
    if (!this.attempt) return;
    const now = new Date();
    this.closeTurn(this.lastSeq, now);
    const span = this.attempt.span;
    span.setAttribute("attempt.state", state);
    span.setAttribute("acp.seq_to", this.lastSeq);
    if (state !== "completed") span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(now);
  }

  private common(f: AttemptFacts): Attributes {
    return {
      "attempt.id": f.attemptId,
      "station.id": this.init.stationId,
      "fingerprint.digest": f.fingerprintDigest,
      ...(this.init.runId ? { "run.id": this.init.runId } : {}),
    };
  }

  private apply(e: AcpEvent): void {
    this.lastSeq = Math.max(this.lastSeq, e.seq);
    const p = record(e.payload);
    switch (e.type) {
      case "user-prompt":
        this.closeTurn(e.seq - 1, timeOf(e));
        this.openTurn(e);
        return;
      case "state":
        if (p.status === "idle" || p.status === "ended") this.closeTurn(e.seq, timeOf(e));
        return;
      case "agent-update":
        this.ensureTurn(e);
        this.onUpdate(e, p);
        return;
      case "permission-request":
        this.ensureTurn(e);
        this.onPermissionRequest(e, p);
        return;
      case "permission-answer":
        this.onPermissionAnswer(e, p);
        return;
      case "error": {
        this.ensureTurn(e);
        this.turn!.span.setStatus({ code: SpanStatusCode.ERROR });
        if (TurnErrorKind.safeParse(p.kind).success) this.turn!.span.setAttribute("error.type", p.kind as string);
        return;
      }
    }
  }

  private openTurn(e: AcpEvent): void {
    const a = this.attempt!;
    const span = this.init.tracer.startSpan(
      "turn",
      { startTime: timeOf(e), attributes: { ...this.common(a.facts), "acp.seq_from": e.seq } },
      a.ctx,
    );
    this.turn = { span, ctx: trace.setSpan(a.ctx, span), seqFrom: e.seq };
  }

  private ensureTurn(e: AcpEvent): void {
    if (!this.turn) this.openTurn(e);
  }

  private closeTurn(seqTo: number, when: Date): void {
    if (!this.turn) return;
    for (const t of this.tools.values()) {
      t.span.setAttribute("tool.status", t.status);
      t.span.setAttribute("acp.seq_to", seqTo);
      t.span.end(when);
    }
    this.tools.clear();
    for (const p of this.permissions.values()) {
      p.span.setAttribute("permission.outcome", "unanswered");
      p.span.end(when);
    }
    this.permissions.clear();
    this.turn.span.setAttribute("acp.seq_to", Math.max(seqTo, this.turn.seqFrom));
    this.turn.span.end(when);
    this.turn = null;
  }

  private onUpdate(e: AcpEvent, p: Record<string, unknown>): void {
    if (p.sessionUpdate !== "tool_call" && p.sessionUpdate !== "tool_call_update") return;
    const id = typeof p.toolCallId === "string" ? p.toolCallId : null;
    if (!id) return;
    let tool = this.tools.get(id);
    if (!tool) {
      if (this.tools.size >= MAX_OPEN_CHILDREN) return;
      const span = this.init.tracer.startSpan(
        "tool_call",
        {
          startTime: timeOf(e),
          attributes: {
            ...this.common(this.attempt!.facts),
            "tool.kind": enumOr(TOOL_KINDS, p.kind, "other"),
            "acp.seq_from": e.seq,
          },
        },
        this.turn!.ctx,
      );
      tool = { span, status: "pending" };
      this.tools.set(id, tool);
    } else if (p.kind !== undefined) {
      tool.span.setAttribute("tool.kind", enumOr(TOOL_KINDS, p.kind, "other"));
    }
    tool.status = enumOr(TOOL_STATUSES, p.status, tool.status);
    if (TERMINAL.has(tool.status)) {
      tool.span.setAttribute("tool.status", tool.status);
      tool.span.setAttribute("acp.seq_to", e.seq);
      if (tool.status === "failed") tool.span.setStatus({ code: SpanStatusCode.ERROR });
      tool.span.end(timeOf(e));
      this.tools.delete(id);
    }
  }

  private onPermissionRequest(e: AcpEvent, p: Record<string, unknown>): void {
    if (this.permissions.size >= MAX_OPEN_CHILDREN) return;
    const optionKinds = new Map<string, string>();
    if (Array.isArray(p.options)) {
      for (const o of p.options) {
        const opt = record(o);
        if (typeof opt.optionId === "string") optionKinds.set(opt.optionId, enumOr(OPTION_KINDS, opt.kind, "other"));
      }
    }
    const span = this.init.tracer.startSpan(
      "permission",
      {
        startTime: timeOf(e),
        attributes: {
          ...this.common(this.attempt!.facts),
          "tool.kind": enumOr(TOOL_KINDS, record(p.toolCall).kind, "other"),
          "permission.auto": p.auto === true,
          "acp.seq_from": e.seq,
        },
      },
      this.turn!.ctx,
    );
    this.permissions.set(e.seq, { span, optionKinds });
  }

  private onPermissionAnswer(e: AcpEvent, p: Record<string, unknown>): void {
    const requestSeq = typeof p.requestSeq === "number" ? p.requestSeq : null;
    const open = requestSeq === null ? undefined : this.permissions.get(requestSeq);
    if (!open) return;
    const outcome =
      p.cancelled === true
        ? "cancelled"
        : typeof p.optionId === "string"
          ? (open.optionKinds.get(p.optionId) ?? "other")
          : "other";
    open.span.setAttribute("permission.outcome", outcome);
    open.span.setAttribute("acp.seq_to", e.seq);
    open.span.end(timeOf(e));
    this.permissions.delete(requestSeq!);
  }
}
