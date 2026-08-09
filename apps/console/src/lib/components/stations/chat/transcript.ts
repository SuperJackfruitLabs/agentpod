/**
 * transcript.ts
 *
 * Pure projection: fold persisted/live `AcpEvent`s into renderable chat items.
 * No Svelte imports — plain TypeScript, so the folding rules are unit-testable
 * and reusable by both the replay path and the live WS stream.
 *
 * Contracts that matter to callers:
 *   - `foldEvent` is pure. It returns a NEW Transcript object but reuses the
 *     references of every ChatItem it did not touch — Svelte 5 fine-grained
 *     reactivity keys off those references.
 *   - Duplicate delivery (ev.seq <= lastSeq, for real seq >= 1 events) is a
 *     no-op that returns the SAME object reference.
 *   - `lastSeq` advances only for real events (seq >= 1), even when the
 *     payload is malformed or unknown — the cursor tracks delivery, not
 *     renderability. Synthetic seq-0 events (client-side errors) never move it.
 *   - Payloads are untrusted `unknown`: unknown `sessionUpdate` values and
 *     malformed payloads are ignored silently (forward compat), never thrown.
 */

import type { AcpEvent, AcpSessionStatus } from "@agentpod/contract";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

export type ChatItem =
  | { kind: "user"; seq: number; text: string; pending?: boolean }
  | { kind: "assistant"; seq: number; text: string; streaming: boolean }
  | { kind: "reasoning"; seq: number; text: string; streaming: boolean }
  | {
      kind: "tool";
      seq: number;
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: ToolStatus;
      content: ToolContent[];
      locations: string[];
    }
  | {
      kind: "permission";
      seq: number;
      requestSeq: number;
      title: string;
      toolKind?: string;
      options: Array<{ optionId: string; name: string; kind: string }>;
      answer?: { optionId?: string; cancelled?: boolean; auto?: boolean };
    }
  | { kind: "notice"; seq: number; level: "info" | "error"; text: string };

export interface Transcript {
  items: ChatItem[];
  lastSeq: number;
  status: AcpSessionStatus;
  usage?: { used: number; size: number };
}

export function emptyTranscript(): Transcript {
  return { items: [], lastSeq: 0, status: "starting", usage: undefined };
}

/** Optimistic local echo: pushed on send, replaced by the real user-prompt event. */
export function addPendingPrompt(t: Transcript, text: string): Transcript {
  return { ...t, items: [...t.items, { kind: "user", seq: -1, text, pending: true }] };
}

// ─── Defensive narrowing helpers ─────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const TOOL_STATUSES: readonly ToolStatus[] = ["pending", "in_progress", "completed", "failed"];
function toolStatus(v: unknown): ToolStatus | undefined {
  return TOOL_STATUSES.includes(v as ToolStatus) ? (v as ToolStatus) : undefined;
}

const SESSION_STATUSES: readonly AcpSessionStatus[] = [
  "starting",
  "idle",
  "working",
  "waiting",
  "ended",
];
function sessionStatus(v: unknown): AcpSessionStatus | undefined {
  return SESSION_STATUSES.includes(v as AcpSessionStatus) ? (v as AcpSessionStatus) : undefined;
}

/** `{type:"text",text}` content block → its text, else undefined. */
function chunkText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  if (!isRecord(content) || content.type !== "text") return undefined;
  return str(content.text);
}

/** Map SDK ToolCallContent entries into renderable ToolContent; unknown types dropped. */
function mapToolContent(v: unknown): ToolContent[] {
  if (!Array.isArray(v)) return [];
  const out: ToolContent[] = [];
  for (const entry of v) {
    if (!isRecord(entry)) continue;
    if (entry.type === "content") {
      const inner = entry.content;
      if (isRecord(inner) && inner.type === "text") {
        const text = str(inner.text);
        if (text !== undefined) out.push({ type: "text", text });
      }
    } else if (entry.type === "diff") {
      const path = str(entry.path);
      const newText = str(entry.newText);
      if (path !== undefined && newText !== undefined) {
        out.push({ type: "diff", path, oldText: str(entry.oldText) ?? null, newText });
      }
    }
    // Unknown content types (terminal, image, …) → ignored (forward compat).
  }
  return out;
}

/** `[{path}, …]` → path strings; malformed entries dropped. */
function mapLocations(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const loc of v) {
    if (isRecord(loc)) {
      const path = str(loc.path);
      if (path !== undefined) out.push(path);
    }
  }
  return out;
}

/** Set `streaming: false` on any open assistant/reasoning items; reuses refs when untouched. */
function closeStreaming(items: ChatItem[]): ChatItem[] {
  if (!items.some((it) => (it.kind === "assistant" || it.kind === "reasoning") && it.streaming)) {
    return items;
  }
  return items.map((it) =>
    (it.kind === "assistant" || it.kind === "reasoning") && it.streaming
      ? { ...it, streaming: false }
      : it,
  );
}

// ─── Folding ─────────────────────────────────────────────────────────────────

export function foldEvent(t: Transcript, ev: AcpEvent): Transcript {
  const real = ev.seq >= 1;
  if (real && ev.seq <= t.lastSeq) return t; // duplicate delivery → idempotent no-op
  const next: Transcript = { ...t, lastSeq: real ? ev.seq : t.lastSeq };

  switch (ev.type) {
    case "user-prompt":
      return foldUserPrompt(next, ev);
    case "agent-update":
      return foldAgentUpdate(next, ev);
    case "permission-request":
      return foldPermissionRequest(next, ev);
    case "permission-answer":
      return foldPermissionAnswer(next, ev);
    case "state":
      return foldState(next, ev);
    case "error":
      return foldError(next, ev);
    default:
      return next; // unknown event type → forward compat
  }
}

function foldUserPrompt(t: Transcript, ev: AcpEvent): Transcript {
  if (!isRecord(ev.payload)) return t;
  const text = str(ev.payload.text);
  if (text === undefined) return t;

  const items = closeStreaming(t.items).slice();
  const last = items.at(-1);
  const item: ChatItem = { kind: "user", seq: ev.seq, text };
  if (last?.kind === "user" && last.pending) {
    items[items.length - 1] = item; // optimistic reconcile: replace, don't duplicate
  } else {
    items.push(item);
  }
  return { ...t, items };
}

function foldAgentUpdate(t: Transcript, ev: AcpEvent): Transcript {
  const payload = ev.payload;
  if (!isRecord(payload)) return t;

  switch (payload.sessionUpdate) {
    case "agent_message_chunk":
      return appendChunk(t, ev.seq, "assistant", chunkText(payload));
    case "agent_thought_chunk":
      return appendChunk(t, ev.seq, "reasoning", chunkText(payload));
    case "tool_call": {
      const toolCallId = str(payload.toolCallId);
      if (toolCallId === undefined) return t;
      const item: ChatItem = {
        kind: "tool",
        seq: ev.seq,
        toolCallId,
        title: str(payload.title) ?? toolCallId,
        toolKind: str(payload.kind),
        status: toolStatus(payload.status) ?? "pending",
        content: mapToolContent(payload.content),
        locations: mapLocations(payload.locations),
      };
      return { ...t, items: [...t.items, item] };
    }
    case "tool_call_update": {
      const toolCallId = str(payload.toolCallId);
      if (toolCallId === undefined) return t;
      const idx = t.items.findLastIndex(
        (it) => it.kind === "tool" && it.toolCallId === toolCallId,
      );
      if (idx === -1) return t; // unknown toolCallId → ignore
      const prev = t.items[idx] as Extract<ChatItem, { kind: "tool" }>;
      const merged: ChatItem = {
        ...prev,
        title: str(payload.title) ?? prev.title,
        toolKind: str(payload.kind) ?? prev.toolKind,
        status: toolStatus(payload.status) ?? prev.status,
        // Content/locations REPLACE when present (SDK semantics); null/absent keeps prior.
        content: Array.isArray(payload.content) ? mapToolContent(payload.content) : prev.content,
        locations: Array.isArray(payload.locations)
          ? mapLocations(payload.locations)
          : prev.locations,
      };
      const items = t.items.slice();
      items[idx] = merged;
      return { ...t, items };
    }
    case "usage_update": {
      const used = payload.used;
      const size = payload.size;
      if (typeof used !== "number" || typeof size !== "number") return t;
      return { ...t, usage: { used, size } };
    }
    default:
      // plan / plan_update / available_commands_update / current_mode_update /
      // anything newer → ignored in v1 (forward compat).
      return t;
  }
}

function appendChunk(
  t: Transcript,
  seq: number,
  kind: "assistant" | "reasoning",
  text: string | undefined,
): Transcript {
  if (text === undefined) return t;
  const items = t.items.slice();
  const last = items.at(-1);
  if (last && last.kind === kind && last.streaming) {
    items[items.length - 1] = { ...last, text: last.text + text };
  } else {
    items.push({ kind, seq, text, streaming: true });
  }
  return { ...t, items };
}

function foldPermissionRequest(t: Transcript, ev: AcpEvent): Transcript {
  if (!isRecord(ev.payload)) return t;
  const toolCall = ev.payload.toolCall;
  if (!isRecord(toolCall)) return t;

  const options: Array<{ optionId: string; name: string; kind: string }> = [];
  if (Array.isArray(ev.payload.options)) {
    for (const opt of ev.payload.options) {
      if (!isRecord(opt)) continue;
      const optionId = str(opt.optionId);
      const name = str(opt.name);
      const kind = str(opt.kind);
      if (optionId !== undefined && name !== undefined && kind !== undefined) {
        options.push({ optionId, name, kind });
      }
    }
  }

  const item: ChatItem = {
    kind: "permission",
    seq: ev.seq,
    requestSeq: ev.seq,
    title: str(toolCall.title) ?? str(toolCall.name) ?? "Permission request",
    toolKind: str(toolCall.kind),
    options,
  };
  return { ...t, items: [...t.items, item] };
}

function foldPermissionAnswer(t: Transcript, ev: AcpEvent): Transcript {
  if (!isRecord(ev.payload)) return t;
  const requestSeq = ev.payload.requestSeq;
  if (typeof requestSeq !== "number") return t;
  const idx = t.items.findLastIndex(
    (it) => it.kind === "permission" && it.requestSeq === requestSeq,
  );
  if (idx === -1) return t; // unknown requestSeq → ignore
  const prev = t.items[idx] as Extract<ChatItem, { kind: "permission" }>;
  const items = t.items.slice();
  items[idx] = {
    ...prev,
    answer: {
      optionId: str(ev.payload.optionId),
      cancelled: ev.payload.cancelled === true ? true : undefined,
      auto: ev.payload.auto === true ? true : undefined,
    },
  };
  return { ...t, items };
}

function foldState(t: Transcript, ev: AcpEvent): Transcript {
  if (!isRecord(ev.payload)) return t;
  const status = sessionStatus(ev.payload.status);
  if (status === undefined) return t; // unknown status → forward compat

  let items = t.items;
  if (status === "idle" || status === "ended") items = closeStreaming(items);
  if (status === "ended") {
    const reason = str(ev.payload.reason);
    items = [
      ...items,
      {
        kind: "notice",
        seq: ev.seq,
        level: "info",
        text: reason ? `Session ended — ${reason}` : "Session ended.",
      },
    ];
  }
  return { ...t, status, items };
}

function foldError(t: Transcript, ev: AcpEvent): Transcript {
  if (!isRecord(ev.payload)) return t;
  const message = str(ev.payload.message);
  if (message === undefined) return t;
  return {
    ...t,
    items: [...t.items, { kind: "notice", seq: ev.seq, level: "error", text: message }],
  };
}
