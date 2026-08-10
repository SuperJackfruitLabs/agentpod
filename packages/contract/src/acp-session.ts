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
