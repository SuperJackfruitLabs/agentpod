import { z } from "zod";
import { TurnErrorKind } from "./acp-session";

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
 * A failed turn, structured so a client can draw it: what failed, which model,
 * and each model the harness fell back to.
 *
 * Carried **inside** the room's error notice, under this one namespaced key,
 * rather than as a separate event beside it. The notice's `body` stays the
 * readable fallback every Matrix client shows; a client that knows the key
 * draws a card in its place. A second event would put the same failure in the
 * room twice — the duplicate the one-error-per-turn work removed (2026-09-26).
 *
 * The same `TurnError` the hub records (`acp-session.ts`), minus what a reader
 * does not need (`source`, the provider's own error type, the HTTP status),
 * and bounded: a client draws every attempt it is given.
 */
export const TURN_ERROR_CONTENT_KEY = "dev.agentpod.turn_error";

export const TurnErrorCardAttempt = z.object({
  provider: z.string().max(200),
  model: z.string().max(200),
  kind: TurnErrorKind,
  message: z.string().max(2000),
});
export type TurnErrorCardAttempt = z.infer<typeof TurnErrorCardAttempt>;

export const TurnErrorCard = z.object({
  schema_version: z.literal(1),
  kind: TurnErrorKind,
  message: z.string().max(4000),
  harness: z.string().max(100),
  provider: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  retryable: z.boolean().optional(),
  attempts: z.array(TurnErrorCardAttempt).max(16).optional(),
});
export type TurnErrorCard = z.infer<typeof TurnErrorCard>;

/**
 * A voice note's transcript, structured so a client can draw it under the
 * note it transcribes.
 *
 * Carried inside the hub's transcript notice — an `m.notice` that is a reply
 * (`m.in_reply_to`) to the voice note — under this one namespaced key. The
 * notice's `body` ("Transcript: …") stays the readable fallback every Matrix
 * client shows; a client that knows the key draws the text as part of the
 * voice note rather than as a separate line. Which note it belongs to is the
 * reply relation, not a field here: a key cannot point at a message the
 * event does not already relate to.
 */
export const VOICE_TRANSCRIPT_CONTENT_KEY = "dev.agentpod.voice_transcript";

export const VoiceTranscript = z.object({
  schema_version: z.literal(1),
  /** What was heard, as the agent received it. */
  text: z.string().max(20_000),
  /** The language the service heard, as an ISO code, when it said. */
  language: z.string().max(16).optional(),
  /** Length of the note in seconds, when the sender's client said. */
  seconds: z.number().int().nonnegative().max(3600).optional(),
});
export type VoiceTranscript = z.infer<typeof VoiceTranscript>;

/**
 * An agent's reply, spoken: what the hub's voice message says it is.
 *
 * Carried on the `m.audio` voice message (MSC3245) the hub posts after a
 * bridge-mode agent's text reply, under this one namespaced key. The text
 * reply is posted first and stays the reply; this names it
 * (`text_event_id`) so a client can draw the voice note with the text it
 * speaks, or fold the two into one bubble. Not an `m.in_reply_to`: a reply
 * relation would make every other client quote the text a second time.
 *
 * `voice` is the speech service's voice id, or a blend
 * (`af_heart:60+af_bella:40`). Versioned like {@link VoiceTranscript}:
 * additive changes bump `schema_version`, unknown fields are stripped.
 */
export const VOICE_REPLY_CONTENT_KEY = "dev.agentpod.voice_reply";

export const VoiceReply = z.object({
  schema_version: z.literal(1),
  /** The agent's text message this voice note speaks. */
  text_event_id: z.string().min(1).max(255),
  /** The voice it was spoken in. */
  voice: z.string().min(1).max(64),
  /** Length of the audio in whole seconds. */
  seconds: z.number().int().nonnegative().max(3600).optional(),
});
export type VoiceReply = z.infer<typeof VoiceReply>;

// ─── Requests that ride on the prose message ─────────────────────────────────
//
// The permission request (`dev.agentpod.permission`, and its legacy `.v1` event), the gate card
// (`dev.superpipeline.gate`) and the question card (`dev.superpipeline.elicitation`) are the
// board-room contract and live in treaty with every other board-room event. Re-exported here so
// the hub, the agent and the console keep one import.
export {
  ELICITATION_REQUEST_CONTENT_KEY,
  ElicitationRequestCard,
  ElicitationRequestOption,
  GATE_REQUEST_CONTENT_KEY,
  GateRequestCard,
  GateRequestOption,
  PERMISSION_REQUEST_CONTENT_KEY,
  PermissionRequestEvent,
} from "@superjackfruitlabs/treaty-matrix-events";
