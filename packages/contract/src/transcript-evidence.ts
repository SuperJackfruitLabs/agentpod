/**
 * The evidence fold: persisted ACP events → transcript items, for a reader who was not there.
 *
 * The console's `foldEvent` (`transcript.ts`) answers "what should the chat show"; this answers
 * "what happened". Same three rules, so the two never disagree about the conversation:
 *
 *   - streaming chunks coalesce into one message (or reasoning) item until something else
 *     happens;
 *   - tool calls upsert by `toolCallId` — a repeat or an update merges, later fields win;
 *   - a permission answer pairs with its request by `requestSeq`.
 *
 * And four differences, each because evidence must not lose a fact the chat can afford to drop:
 *
 *   - every item records the seqs it was built from (`seq`, or `seq_from`..`seq_to`);
 *   - a tool call keeps `rawInput` and `rawOutput`, and its content verbatim;
 *   - an update or answer whose start lies before the range still makes an item, marked
 *     `partial: true` (the chat ignores it, because the chat always starts from seq 1);
 *   - nothing is dropped: every state is an item, and an event this fold does not understand
 *     becomes `{kind: "other"}` naming its type.
 *
 * Pure, and safe on untrusted payloads: nothing here throws. Redaction and size limits are the
 * hub's job and happen after folding (so a secret split across two chunks is whole by then).
 */
import type { ToolStatus } from "./matrix-events";
import { chunkText, isRecord, str, toolStatus } from "./transcript-narrow";

/**
 * A persisted event as the fold reads it. `type` is a plain string, not `AcpEventType`: rows
 * come from the database, and a type this build has never heard of must fold to `other`, not
 * fail to type-check at the boundary.
 */
export interface EvidenceEvent {
  seq: number;
  type: string;
  payload: unknown;
}

export type EvidencePermissionOutcome = `selected:${string}` | "cancelled" | "auto" | "pending";

export type EvidenceItem =
  | { kind: "prompt"; seq: number; text: string; images: Array<{ name: string; mimeType: string }> }
  | { kind: "message"; seq_from: number; seq_to: number; text: string }
  | { kind: "reasoning"; seq_from: number; seq_to: number; text: string }
  | {
      kind: "tool_call";
      id: string;
      seq_from: number;
      seq_to: number;
      title: string;
      tool_kind: string | null;
      status: ToolStatus;
      input: unknown;
      output: { content: unknown; raw: unknown };
      partial?: true;
    }
  | {
      kind: "permission";
      seq: number;
      answer_seq?: number;
      tool_call_id?: string;
      title: string;
      options: Array<{ optionId: string; name: string; kind: string }>;
      outcome: EvidencePermissionOutcome;
      partial?: true;
    }
  | { kind: "state"; seq: number; status: string; reason?: string }
  | { kind: "error"; seq: number; error_kind: string; message: string }
  | { kind: "other"; seq: number; type: string };

export type EvidenceItemKind = EvidenceItem["kind"];

/**
 * The fold's working state. `open` is the index of a message/reasoning item still taking chunks,
 * which is the console's `streaming` flag kept off the wire.
 */
export interface EvidenceFold {
  items: EvidenceItem[];
  open: number | null;
}

export function emptyEvidenceFold(): EvidenceFold {
  return { items: [], open: null };
}

/**
 * The seq an item starts at, inside the range it was folded from: what paging orders by, what a
 * cursor points at, and what the item route's `:seqFrom` names. `seq_from` where an item has one;
 * for a PARTIAL permission, its answer (its request lies before the range); otherwise `seq`.
 */
export function itemFirstSeq(item: EvidenceItem): number {
  if ("seq_from" in item) return item.seq_from;
  if (item.kind === "permission" && item.partial && item.answer_seq !== undefined) return item.answer_seq;
  return item.seq;
}

/** Fold every event, in the order given (callers pass seq order). */
export function foldEvidence(events: Iterable<EvidenceEvent>): EvidenceItem[] {
  let f = emptyEvidenceFold();
  for (const ev of events) f = foldEvidenceEvent(f, ev);
  return f.items;
}

/** Fold one event. Mutates and returns `f`: this runs server-side over thousands of rows. */
export function foldEvidenceEvent(f: EvidenceFold, ev: EvidenceEvent): EvidenceFold {
  const handled =
    ev.type === "user-prompt" ? foldPrompt(f, ev)
    : ev.type === "agent-update" ? foldUpdate(f, ev)
    : ev.type === "permission-request" ? foldRequest(f, ev)
    : ev.type === "permission-answer" ? foldAnswer(f, ev)
    : ev.type === "state" ? foldState(f, ev)
    : ev.type === "error" ? foldError(f, ev)
    : false;
  if (!handled) {
    const sub = ev.type === "agent-update" && isRecord(ev.payload) ? str(ev.payload.sessionUpdate) : undefined;
    push(f, { kind: "other", seq: ev.seq, type: sub ? `agent-update:${sub}` : ev.type });
  }
  return f;
}

type Ev = EvidenceEvent;

function push(f: EvidenceFold, item: EvidenceItem): void {
  f.items.push(item);
  f.open = null;
}

function foldPrompt(f: EvidenceFold, ev: Ev): boolean {
  if (!isRecord(ev.payload)) return false;
  const text = str(ev.payload.text);
  if (text === undefined) return false;
  const images: Array<{ name: string; mimeType: string }> = [];
  if (Array.isArray(ev.payload.images)) {
    for (const img of ev.payload.images) {
      // `bytes` is never carried: it is the picture itself, not a fact about the turn.
      if (isRecord(img)) images.push({ name: str(img.name) ?? "", mimeType: str(img.mimeType) ?? "" });
    }
  }
  push(f, { kind: "prompt", seq: ev.seq, text, images });
  return true;
}

function foldUpdate(f: EvidenceFold, ev: Ev): boolean {
  const p = ev.payload;
  if (!isRecord(p)) return false;
  switch (p.sessionUpdate) {
    case "agent_message_chunk":
      return appendChunk(f, ev.seq, "message", chunkText(p));
    case "agent_thought_chunk":
      return appendChunk(f, ev.seq, "reasoning", chunkText(p));
    case "tool_call":
    case "tool_call_update": {
      const id = str(p.toolCallId);
      if (id === undefined) return false;
      const idx = findTool(f, id);
      if (idx === -1) {
        push(f, {
          kind: "tool_call",
          id,
          seq_from: ev.seq,
          seq_to: ev.seq,
          title: str(p.title) ?? id,
          tool_kind: str(p.kind) ?? null,
          status: toolStatus(p.status) ?? "pending",
          input: "rawInput" in p ? p.rawInput : null,
          output: { content: Array.isArray(p.content) ? p.content : null, raw: "rawOutput" in p ? p.rawOutput : null },
          ...(p.sessionUpdate === "tool_call_update" ? { partial: true as const } : {}),
        });
        return true;
      }
      const prev = f.items[idx] as Extract<EvidenceItem, { kind: "tool_call" }>;
      f.items[idx] = {
        ...prev,
        seq_to: ev.seq,
        title: str(p.title) ?? prev.title,
        tool_kind: str(p.kind) ?? prev.tool_kind,
        status: toolStatus(p.status) ?? prev.status,
        input: "rawInput" in p ? p.rawInput : prev.input,
        output: {
          // ACP: content REPLACES when an array is present; null/absent means unchanged.
          content: Array.isArray(p.content) ? p.content : prev.output.content,
          raw: "rawOutput" in p ? p.rawOutput : prev.output.raw,
        },
      };
      return true;
    }
    default:
      return false; // plan, usage_update, available_commands_update, … → `other`
  }
}

function findTool(f: EvidenceFold, id: string): number {
  return f.items.findLastIndex((it) => it.kind === "tool_call" && it.id === id);
}

function appendChunk(f: EvidenceFold, seq: number, kind: "message" | "reasoning", text: string | undefined): boolean {
  if (text === undefined) return false;
  const open = f.open === null ? undefined : f.items[f.open];
  if (open && open.kind === kind) {
    f.items[f.open!] = { ...open, seq_to: seq, text: open.text + text };
    return true;
  }
  push(f, { kind, seq_from: seq, seq_to: seq, text });
  f.open = f.items.length - 1;
  return true;
}

function options(v: unknown): Array<{ optionId: string; name: string; kind: string }> {
  const out: Array<{ optionId: string; name: string; kind: string }> = [];
  if (!Array.isArray(v)) return out;
  for (const opt of v) {
    if (!isRecord(opt)) continue;
    const optionId = str(opt.optionId);
    const name = str(opt.name);
    const kind = str(opt.kind);
    if (optionId !== undefined && name !== undefined && kind !== undefined) out.push({ optionId, name, kind });
  }
  return out;
}

function foldRequest(f: EvidenceFold, ev: Ev): boolean {
  if (!isRecord(ev.payload)) return false;
  const toolCall = ev.payload.toolCall;
  if (!isRecord(toolCall)) return false;
  const toolCallId = str(toolCall.toolCallId);
  push(f, {
    kind: "permission",
    seq: ev.seq,
    ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
    title: str(toolCall.title) ?? str(toolCall.name) ?? "Permission request",
    options: options(ev.payload.options),
    outcome: "pending",
  });
  return true;
}

function outcomeOf(p: Record<string, unknown>): EvidencePermissionOutcome {
  if (p.cancelled === true) return "cancelled";
  if (p.auto === true) return "auto";
  const optionId = str(p.optionId);
  return optionId !== undefined ? `selected:${optionId}` : "pending";
}

function foldAnswer(f: EvidenceFold, ev: Ev): boolean {
  if (!isRecord(ev.payload)) return false;
  const requestSeq = ev.payload.requestSeq;
  if (typeof requestSeq !== "number") return false;
  const idx = f.items.findLastIndex((it) => it.kind === "permission" && it.seq === requestSeq);
  if (idx === -1) {
    // The request lies before the range: what the answer says, and nothing it does not.
    push(f, {
      kind: "permission",
      seq: requestSeq,
      answer_seq: ev.seq,
      title: "Permission request",
      options: [],
      outcome: outcomeOf(ev.payload),
      partial: true,
    });
    return true;
  }
  const prev = f.items[idx] as Extract<EvidenceItem, { kind: "permission" }>;
  f.items[idx] = { ...prev, answer_seq: ev.seq, outcome: outcomeOf(ev.payload) };
  return true;
}

function foldState(f: EvidenceFold, ev: Ev): boolean {
  if (!isRecord(ev.payload)) return false;
  const status = str(ev.payload.status);
  if (status === undefined) return false;
  const reason = str(ev.payload.reason);
  push(f, { kind: "state", seq: ev.seq, status, ...(reason !== undefined ? { reason } : {}) });
  return true;
}

function foldError(f: EvidenceFold, ev: Ev): boolean {
  if (!isRecord(ev.payload)) return false;
  const message = str(ev.payload.message);
  if (message === undefined) return false;
  push(f, { kind: "error", seq: ev.seq, error_kind: str(ev.payload.kind) ?? "unknown", message });
  return true;
}
