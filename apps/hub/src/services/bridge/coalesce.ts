/**
 * ACP transcript events → board activities, coalesced.
 *
 * **Coalescing is a property of the seam, not an optimisation.** Spike RQ1 ran
 * the same trivial prompt on two live stations: Codex emitted 57 ACP events,
 * Hermes emitted 1,051 — 840 `agent_message_chunk` plus 202
 * `agent_thought_chunk`, because it streams token by token. A 1:1 projection
 * would fire over a thousand HTTP POSTs at a board for one short instruction,
 * and the 18x spread between harnesses means no fixed rate limit fits both.
 *
 * So the rule here is not "post less often". It is: **the number of activities
 * depends on the content, not on how finely the harness chunked it.** Ephemeral
 * chunks accumulate; the buffer is flushed on a boundary — a durable event, a
 * change of chunk kind, the end of the turn, or a size cap — and only then does
 * anything leave the bridge. Two harnesses running the same instruction produce
 * the same activities.
 *
 * kaambaan's envelope already anticipates this (`ephemeral: true` means "render
 * transiently, replaced by the next activity") but nothing on either side
 * enforces that a producer coalesces first. This is that enforcement.
 */

import type { AcpEvent } from "@agentpod/contract";

import { isAutoAnswered, permissionQuestion, toBoardOptions } from "./permission";

/**
 * One kaambaan activity, in the shape its REST handler actually reads.
 *
 * Pinned against kaambaan `apps/api/src/index.ts:390-403`, which destructures
 * `{type, ephemeral, body, action, parameter, result, signal, usage}` from the
 * request body. Note what is NOT there: `signalMetadata`. The spike sent an
 * elicitation's options in that field and they were dropped on the wire without
 * an error — so structured options ride in `parameter`, which is stored.
 */
export interface BoardActivity {
  type: "thought" | "action" | "response" | "elicitation" | "error";
  body?: string;
  action?: string;
  parameter?: unknown;
  result?: unknown;
  ephemeral?: boolean;
  signal?: string;
}

/** Ephemeral chunk kinds — the two that produced 1,042 of Hermes's 1,051 events. */
const CHUNK_KINDS = {
  agent_message_chunk: { type: "response", ephemeral: false },
  agent_thought_chunk: { type: "thought", ephemeral: true },
} as const;
type ChunkKind = keyof typeof CHUNK_KINDS;

/**
 * Kinds with no board representation, dropped on purpose (RQ1 §2). Listed
 * rather than defaulted so a NEW kind shows up in `unmapped()` instead of
 * joining this set by accident.
 */
const DROPPED_KINDS = new Set([
  "available_commands_update", // the harness's slash-command catalogue
  "session_info_update", // kaambaan derives its own state; ours would fight it
  "current_mode_update", // permission mode is the hub's business
]);

/** Above this, one durable warning that the context window is filling. */
const DEFAULT_CONTEXT_WARN_PCT = 80;

/**
 * Cap on a single buffered body. The valve, not the mechanism: it bounds one
 * activity's size without reintroducing a per-event post rate.
 */
const DEFAULT_MAX_BUFFER_CHARS = 4_000;

export interface ContextPeak {
  pct: number;
  used: number;
  size: number;
}

export interface CoalescerOptions {
  maxBufferChars?: number;
  contextWarnPct?: number;
}

export class ActivityCoalescer {
  private readonly maxBufferChars: number;
  private readonly contextWarnPct: number;

  private buffer: { kind: ChunkKind; text: string } | null = null;
  /** The tool call whose update is still being collapsed, if any. */
  private pendingTool: { id: string; activity: BoardActivity } | null = null;

  private peak: ContextPeak | null = null;
  private warned = false;

  private readonly unmappedKinds = new Set<string>();
  private readonly lossKinds = new Set<string>();

  constructor(opts: CoalescerOptions = {}) {
    this.maxBufferChars = opts.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
    this.contextWarnPct = opts.contextWarnPct ?? DEFAULT_CONTEXT_WARN_PCT;
  }

  /** Event kinds with no projection at all — evidence, not a failure. */
  unmapped(): string[] {
    return [...this.unmappedKinds].sort();
  }

  /** Kinds that project but lose structure on the way. */
  losses(): string[] {
    return [...this.lossKinds].sort();
  }

  /** Highest context occupancy seen — for the completion handoff. */
  contextPeak(): ContextPeak | null {
    return this.peak;
  }

  /**
   * Feed one transcript event. Returns the activities that are ready to post
   * *now* — usually none, because a chunk is buffered until a boundary.
   */
  push(event: AcpEvent): BoardActivity[] {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    switch (event.type) {
      // The prompt is what we sent; the board already has the card.
      case "user-prompt":
        return [];

      // Session lifecycle. kaambaan derives task state from activities, so
      // forwarding ours would fight its state machine.
      case "state":
        return [];

      case "error":
        return this.durable({ type: "error", body: String(payload.message ?? "agent error") });

      case "permission-request":
        // A request the hub answered itself is not a question. `full-auto`
        // auto-allows everything and `accept-edits` auto-allows edits, and both
        // still persist this event — projecting one as an elicitation would put
        // the card in `input-required` waiting on a decision already made, with
        // nothing parked to receive an answer.
        if (isAutoAnswered(payload)) {
          return this.durable({
            type: "thought",
            ephemeral: true,
            body: `${permissionQuestion(payload)} (answered by the hub's permission mode)`,
          });
        }
        return this.durable({
          type: "elicitation",
          body: permissionQuestion(payload),
          signal: "select",
          // `parameter`, not `signalMetadata`: see BoardActivity. And the
          // options are TRANSLATED, not forwarded — kaambaan echoes the chosen
          // option's `name` back, so `name` has to be the ACP `optionId`.
          parameter: { requestSeq: event.seq, options: toBoardOptions(payload.options) },
        });

      case "permission-answer":
        return this.durable({
          type: "thought",
          body: `permission answered: ${String(payload.optionId ?? "cancelled")}`,
          ephemeral: true,
        });

      case "agent-update":
        return this.update(payload);

      default:
        this.unmappedKinds.add(event.type);
        return [];
    }
  }

  /** End of turn. Emits whatever is still buffered; idempotent. */
  flush(): BoardActivity[] {
    const out = this.flushBuffer();
    if (this.pendingTool) {
      out.push(this.pendingTool.activity);
      this.pendingTool = null;
    }
    return out;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private update(p: Record<string, unknown>): BoardActivity[] {
    const kind = String(p.sessionUpdate ?? "");

    if (kind in CHUNK_KINDS) {
      if (kind === "agent_thought_chunk") {
        // kaambaan has no reasoning affordance distinct from ordinary messages,
        // so the console's collapsible reasoning block cannot be reconstructed
        // from the activity stream. Recorded rather than hidden.
        this.lossKinds.add("agent_thought_chunk → thought (reasoning/message distinction lost)");
      }
      return this.appendChunk(kind as ChunkKind, textOf(p.content));
    }

    switch (kind) {
      case "tool_call":
        return this.durable({
          type: "action",
          action: String(p.title ?? p.kind ?? "tool"),
          parameter: p.rawInput ?? p.locations,
        });

      case "tool_call_update": {
        // Tool updates stream too. Consecutive updates for one call collapse to
        // its last state, which is the only one a board can act on.
        const id = String(p.toolCallId ?? "");
        const activity: BoardActivity = {
          type: "action",
          action: String(p.title ?? p.kind ?? "tool"),
          result: p.rawOutput ?? p.status ?? p.content,
        };
        if (this.pendingTool && this.pendingTool.id === id) {
          this.pendingTool.activity = activity;
          return [];
        }
        const out = this.flushBuffer();
        if (this.pendingTool) out.push(this.pendingTool.activity);
        this.pendingTool = { id, activity };
        return out;
      }

      case "plan":
        this.lossKinds.add("plan → thought (an agent plan has no board representation)");
        return this.durable({
          type: "thought",
          body: JSON.stringify(p.entries ?? p),
          ephemeral: true,
        });

      case "usage_update":
        return this.context(p);

      default:
        if (!DROPPED_KINDS.has(kind)) this.unmappedKinds.add(`agent-update:${kind}`);
        return [];
    }
  }

  private appendChunk(kind: ChunkKind, text: string): BoardActivity[] {
    const out: BoardActivity[] = [];
    if (this.pendingTool) {
      out.push(this.pendingTool.activity);
      this.pendingTool = null;
    }
    if (this.buffer && this.buffer.kind !== kind) out.push(...this.flushBuffer());
    if (!this.buffer) this.buffer = { kind, text: "" };
    this.buffer.text += text;
    if (this.buffer.text.length >= this.maxBufferChars) out.push(...this.flushBuffer());
    return out;
  }

  /** A durable activity is its own boundary: everything buffered goes first. */
  private durable(activity: BoardActivity): BoardActivity[] {
    const out = this.flushBuffer();
    if (this.pendingTool) {
      out.push(this.pendingTool.activity);
      this.pendingTool = null;
    }
    out.push(activity);
    return out;
  }

  private flushBuffer(): BoardActivity[] {
    const buffered = this.buffer;
    this.buffer = null;
    if (!buffered || buffered.text === "") return [];
    const shape = CHUNK_KINDS[buffered.kind];
    return [{ type: shape.type, body: buffered.text, ephemeral: shape.ephemeral }];
  }

  /**
   * `usage_update` is `{used, size}` — how full the context is. NOT tokens and
   * NOT money: RQ5 searched 1,108 events across both harnesses for token and
   * cost fields and found zero. Deliberately never mapped onto kaambaan's
   * `usage` field, which means exactly those two things and feeds a budget cap.
   *
   * Two events per run say nothing on their own, so: track the peak, and emit
   * one durable warning if it crosses the threshold.
   */
  private context(p: Record<string, unknown>): BoardActivity[] {
    const used = Number(p.used ?? 0);
    const size = Number(p.size ?? 0);
    if (!size) return [];

    const pct = Math.round((used / size) * 100);
    if (!this.peak || pct > this.peak.pct) this.peak = { pct, used, size };
    if (pct < this.contextWarnPct || this.warned) return [];

    this.warned = true;
    return this.durable({
      type: "thought",
      ephemeral: false,
      body:
        `⚠️ Context window ${pct}% full (${used.toLocaleString("en-US")} of ` +
        `${size.toLocaleString("en-US")}). The agent may start truncating or compacting.`,
    });
  }
}

/** ACP content blocks are a string, a `{type:"text"}` block, or an array of them. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  const c = content as { type?: string; text?: string } | null;
  if (c && c.type === "text") return String(c.text ?? "");
  return content === undefined || content === null ? "" : JSON.stringify(content);
}
