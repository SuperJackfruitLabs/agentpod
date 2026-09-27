import { z } from "zod";

// ─── ACP session ────────────────────────────────────────────────────────────

export const AcpSessionMode = z.enum(["ask", "accept-edits", "full-auto"]);
export type AcpSessionMode = z.infer<typeof AcpSessionMode>;

export const AcpSessionStatus = z.enum(["starting", "idle", "working", "waiting", "ended"]);
export type AcpSessionStatus = z.infer<typeof AcpSessionStatus>;

export const AcpSessionRow = z.object({
  id: z.string(), stationId: z.string(), userId: z.string(),
  mode: AcpSessionMode, status: AcpSessionStatus,
  endedReason: z.string().nullable(),
  createdAt: z.string(), lastEventAt: z.string(),
  // Slice 4c (history). Both optional so hub and console can deploy
  // independently: a console built before this slice still parses new rows,
  // and a new console tolerates rows from an older hub.
  title: z.string().nullable().optional(),   // first prompt, truncated; null until the first prompt
  lastSeq: z.number().int().optional(),      // highest event seq persisted for the session
});
export type AcpSessionRow = z.infer<typeof AcpSessionRow>;

// ─── ACP transcript event ───────────────────────────────────────────────────

// Append-only transcript event. `payload` is intentionally loose (z.unknown()):
// it carries the SDK's sessionUpdate/permission payloads verbatim; the console
// renders known shapes and ignores the rest. `seq` is a per-session monotonic
// integer assigned by the hub.
export const AcpEventType = z.enum([
  "user-prompt", "agent-update", "permission-request", "permission-answer", "state", "error",
]);
export type AcpEventType = z.infer<typeof AcpEventType>;

export const AcpEvent = z.object({
  sessionId: z.string(), seq: z.number().int(), type: AcpEventType,
  payload: z.unknown(), createdAt: z.string(),
});
export type AcpEvent = z.infer<typeof AcpEvent>;

// ─── Turn error ─────────────────────────────────────────────────────────────

// What went wrong in a turn, in one shape whichever harness failed. The six
// harnesses fail six ways over ACP (a rejection with the text in `message`, in
// `data`, as an ordinary answer, or not at all), so the hub reduces all of them
// to this. See docs/superpowers/specs/2026-09-25-harness-error-standard-design.md.
export const TurnErrorKind = z.enum([
  "quota", "rate_limit", "auth", "bad_request", "context_exhausted", "timeout",
  "provider_unavailable", "refusal", "max_tokens", "cancelled", "node_offline",
  "harness_exited", "unknown",
]);
export type TurnErrorKind = z.infer<typeof TurnErrorKind>;

export const TurnErrorSource = z.enum(["acp-rejection", "acp-stop-reason", "session-state", "hub", "plugin"]);
export type TurnErrorSource = z.infer<typeof TurnErrorSource>;

export const TurnErrorAttempt = z.object({
  provider: z.string(), model: z.string(), kind: TurnErrorKind, message: z.string(),
  providerErrorType: z.string().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
export type TurnErrorAttempt = z.infer<typeof TurnErrorAttempt>;

export const TurnError = z.object({
  /** The provider's or harness's own words. Never summarised. */
  message: z.string(),
  kind: TurnErrorKind,
  harness: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  /**
   * The provider's own name for the failure, from its response body
   * (Anthropic's `invalid_request_error`, opencode-go's `MissingSessionID`).
   * Classified before any words are read; not shown to the reader.
   */
  providerErrorType: z.string().optional(),
  /** The provider's HTTP status, when the harness saw one. */
  httpStatus: z.number().int().min(100).max(599).optional(),
  /** Each model the harness tried, in order, when it fell back. */
  attempts: z.array(TurnErrorAttempt).optional(),
  /** Whether sending the same message again could work. Absent when unknown. */
  retryable: z.boolean().optional(),
  source: TurnErrorSource,
});
export type TurnError = z.infer<typeof TurnError>;

// The payload of an `error` event. `message` is the one field every reader has
// always used, so it stays required at the top level; the rest of TurnError is
// additive, and absent on events written before it existed.
export const TurnErrorPayload = TurnError.partial().extend({ message: z.string() });
export type TurnErrorPayload = z.infer<typeof TurnErrorPayload>;

// ─── ACP session WS protocol ─────────────────────────────────────────────────

// Console → hub over the session WS:
export const AcpClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("subscribe"), sinceSeq: z.number().int().nonnegative() }),
  z.object({ t: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ t: z.literal("cancel") }),
  z.object({ t: z.literal("permission-answer"), requestSeq: z.number().int(), optionId: z.string() }),
  z.object({ t: z.literal("set-mode"), mode: AcpSessionMode }),
]);
export type AcpClientMsg = z.infer<typeof AcpClientMsg>;

// Hub → console:
export const AcpServerMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("event"), event: AcpEvent }),
  z.object({ t: z.literal("replay-done"), lastSeq: z.number().int() }),
  z.object({ t: z.literal("session"), session: AcpSessionRow }),
  z.object({ t: z.literal("bye"), reason: z.string() }),
]);
export type AcpServerMsg = z.infer<typeof AcpServerMsg>;
