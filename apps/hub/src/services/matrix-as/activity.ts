/**
 * What the Matrix path does with the parts of an ACP turn it does not forward.
 *
 * `outbound.ts` answered exactly one question — "is this an
 * `agent_message_chunk`?" — and returned `undefined` for everything else. No
 * default case, no logging, no record. That is how `tool_call`,
 * `agent_thought_chunk`, `plan` and `usage_update` came to be discarded for the
 * whole life of the bridge with nothing anywhere saying so, while the console
 * rendered all of them.
 *
 * The kaambaan coalescer already keeps `unmapped()`/`losses()` and lists its
 * dropped kinds explicitly "so a NEW kind shows up in `unmapped()` instead of
 * joining this set by accident" (`bridge/coalesce.ts:53-62`). This is that
 * discipline, on the path that lacked it — and it ships before anything else in
 * this feature, because it is what makes the rest observable.
 */

import { ToolStatus } from "@agentpod/contract";

/**
 * Kinds seen and not handled, for the life of the process.
 *
 * Module-level rather than per-attachment: the question is "does this fleet's
 * harness emit something we ignore", which is not a property of any one room.
 * A `Set` is also what makes the log once-per-kind rather than once-per-event —
 * a single turn emits hundreds of the same update, and a line per event would
 * bury the signal this exists to raise.
 */
const unmapped = new Set<string>();

/**
 * The kinds this path forwards.
 *
 * Checked before recording an unmapped kind, because "we handle this" and "this
 * particular payload was usable" are different questions. A `tool_call` with no
 * `toolCallId` is malformed, not unsupported — and since a kind is recorded at
 * most once, letting one bad payload in would leave `tool_call` listed as
 * dropped for the life of the process, which is a lie that never corrects
 * itself.
 */
const HANDLED_KINDS = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);

/**
 * Records `kind` as unhandled. Returns whether it was **new**, so the caller
 * logs only the first time — a kind that arrives four hundred times says so
 * once.
 *
 * Guards the type rather than trusting it: `payload.sessionUpdate` comes off a
 * `z.unknown()` payload (`packages/contract`'s `AcpEvent`), so nothing upstream
 * promises it is a string or present at all. A non-string is not recorded,
 * because "we dropped something called 42" would be worse than silence.
 */
export function noteUnmappedKind(kind: string): boolean {
  if (typeof kind !== "string" || kind === "") return false;
  if (HANDLED_KINDS.has(kind)) return false;
  if (unmapped.has(kind)) return false;
  unmapped.add(kind);
  return true;
}

/** Every unhandled kind seen so far, sorted so two runs of a fleet read the same. */
export function unmappedKinds(): string[] {
  return [...unmapped].sort();
}

/**
 * Test seam. The set deliberately outlives any one attachment, so a test that
 * wants to observe it from empty has to say so.
 */
export function _resetUnmappedForTest(): void {
  unmapped.clear();
}

// ─── A turn's tool calls ─────────────────────────────────────────────────────

/** One tool call, accumulated across its `tool_call` and every update to it. */
export interface ToolRecord {
  id: string;
  title: string;
  kind: string | undefined;
  status: ToolStatus;
  locations: string[];
}

function toolStatus(value: unknown): ToolStatus | undefined {
  const parsed = ToolStatus.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The `path` of every location that has one.
 *
 * `undefined` rather than `[]` when the field is absent, so a `tool_call_update`
 * that says nothing about locations keeps the ones its `tool_call` gave, while
 * one that says "no locations" can still clear them.
 */
function locationPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (entry !== null && typeof entry === "object") {
      const path = (entry as Record<string, unknown>).path;
      if (typeof path === "string") out.push(path);
    }
  }
  return out;
}

/**
 * Folds a `tool_call` or `tool_call_update` into `tools`, returning the record
 * as it now stands — or `null` when the payload is neither.
 *
 * **Upsert, never append.** A repeated `toolCallId` merges, for the reason the
 * console records at `transcript.ts:299-305`: a buggy or hostile agent
 * repeating an id must not produce two records with one identity. `Map`
 * preserves insertion order, so an update to an early call leaves it where it
 * was and the durable record reads in the order the work actually happened.
 *
 * Every field falls back to what the call already had, so an update carrying
 * only a status keeps its title. A ticker that forgets what it is doing halfway
 * through is worse than one a moment out of date.
 */
export function foldToolUpdate(
  tools: Map<string, ToolRecord>,
  payload: unknown
): ToolRecord | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.sessionUpdate !== "tool_call" && p.sessionUpdate !== "tool_call_update") return null;

  // Nothing can merge onto a call with no id, and inventing one would make two
  // updates of the same call look like two calls.
  const id = typeof p.toolCallId === "string" ? p.toolCallId : undefined;
  if (id === undefined) return null;

  const existing = tools.get(id);
  const record: ToolRecord = {
    id,
    // The id is the last resort rather than a blank: a card must never render a
    // nameless row.
    title: typeof p.title === "string" ? p.title : (existing?.title ?? id),
    kind: typeof p.kind === "string" ? p.kind : existing?.kind,
    status: toolStatus(p.status) ?? existing?.status ?? "pending",
    locations: locationPaths(p.locations) ?? existing?.locations ?? [],
  };
  tools.set(id, record);
  return record;
}
