import { z } from "zod";

// ─── Matrix event payloads the hub sends ─────────────────────────────────────
//
// What an agent is doing, as it reaches a Matrix client. Two channels, and the
// split between them is the design rather than an implementation detail — see
// `apps/hub/src/services/matrix-as/live.ts`, which argues it at length for the
// answer text and which this extends rather than reopens:
//
//   - **Live** activity goes to-device. It is delivered per device, never
//     stored in a room, and costs room history nothing. A device that was
//     asleep simply misses it.
//   - **The durable record** is one room event per turn. Not one per action:
//     more events per turn means more limited syncs, and a limited sync
//     unloads the timeline.
//
// Snake_case throughout, like every other Matrix event body and like `live.ts`'s
// existing `deltaContent`. `schema_version` in particular is snake_case because
// that is the field supermessage's `readSchemaVersion` looks for; camelCasing it
// makes every payload read as "assume the baseline version" with no error
// raised anywhere.

/**
 * ACP's tool lifecycle, verbatim.
 *
 * Kept identical to the console's own `TOOL_STATUSES` so the two consumers of
 * the same harness cannot drift into disagreeing about what a tool call is
 * doing.
 */
export const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

/**
 * A turn's reasoning, streamed to the reader's own devices.
 *
 * **Deliberately the same shape as `dev.agentpod.stream.delta`.** The client's
 * seq-ordering and its reveal pacer already handle "cumulative text with a
 * monotonic seq, delivered at-least-once and unordered", so reusing the shape
 * costs one registration rather than a second implementation. The *type* still
 * differs, because a reader must be able to tell an agent's thinking from its
 * answer.
 *
 * `text` is EVERYTHING so far, never the increment — to-device delivery is
 * at-least-once and unordered, so an increment would let a dropped or reordered
 * delta corrupt the text with no way to notice.
 */
export const LiveThoughtDelta = z.object({
  room_id: z.string(),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  done: z.boolean(),
});
export type LiveThoughtDelta = z.infer<typeof LiveThoughtDelta>;

/**
 * One tool call's state, streamed as it changes.
 *
 * `tool_call` and `tool_call_update` both produce this; the receiver upserts by
 * `tool_call_id` rather than appending, for the reason the console records: an
 * agent repeating an id must merge, not produce two records with one identity.
 *
 * Tool *output* is deliberately absent. `rawOutput` is unbounded — a `cat` of a
 * large file, a full test log — and this is a live ticker, not a viewer.
 * `title` and `locations` are what answer "what is it doing right now".
 */
export const LiveToolUpdate = z.object({
  room_id: z.string(),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  tool_call_id: z.string(),
  title: z.string(),
  /**
   * ACP's tool kind, passed through unvalidated. Treat as opaque display text
   * and never switch on it exhaustively: a harness inventing a new kind must
   * land as an unknown string rather than as a crash.
   */
  kind: z.string().optional(),
  status: ToolStatus,
  locations: z.array(z.string()),
});
export type LiveToolUpdate = z.infer<typeof LiveToolUpdate>;

/** One tool call as it appears in the durable per-turn record. */
export const TurnActivityTool = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  status: ToolStatus,
  locations: z.array(z.string()),
});
export type TurnActivityTool = z.infer<typeof TurnActivityTool>;

/**
 * What an agent did during one turn — the durable record, sent into the room
 * once, before the answer.
 *
 * `tools` is capped by the sender; `counts` reports the whole turn regardless,
 * so a capped list can never be mistaken for a complete one.
 *
 * An empty `tools` array is valid here even though the hub only sends this when
 * a turn used at least one tool. That guard is the caller's rule, not the
 * wire's — a schema that made "no tools" inexpressible would be describing the
 * sender rather than the format.
 */
export const TurnActivity = z.object({
  schema_version: z.literal(1),
  session_id: z.string(),
  tools: z.array(TurnActivityTool),
  counts: z.object({
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
  }),
});
export type TurnActivity = z.infer<typeof TurnActivity>;

/**
 * A permission request, structured so a client can render buttons.
 *
 * Sent **beside** the existing prose message, which is unchanged and remains
 * the interop path for every other Matrix client. The answer travels back as an
 * ordinary room message carrying the option's `name`, which
 * `matrix-as/permissions.ts`'s `matchPermissionAnswer` already accepts — which
 * is why structured approvals need no new send path on either side.
 *
 * Four options maximum, because supermessage's `DECISION_MAX_OPTIONS` renders
 * four and silently drops the rest. Enforcing it here means the hub never sends
 * something it knows will be discarded — the cap is applied where it can still
 * be reported rather than where it can only be lost. The prose message is not
 * capped and still lists every option, so a fifth stays answerable by number or
 * name; it just does not get a button.
 */
export const PermissionRequestEvent = z.object({
  schema_version: z.literal(1),
  session_id: z.string(),
  /** The request's own ACP sequence number — how `answerPermission` addresses it. */
  request_seq: z.number().int().nonnegative(),
  title: z.string(),
  options: z.array(z.object({ option_id: z.string(), name: z.string() })).min(1).max(4),
});
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEvent>;
