/**
 * Narrowing helpers shared by the two transcript folds: the console's `foldEvent`
 * (`transcript.ts`) and the evidence fold (`transcript-evidence.ts`).
 *
 * Internal to this package — deliberately NOT exported from `index.ts`, because names like
 * `str` and `isRecord` mean nothing to a consumer and would collide with theirs.
 * Payloads are untrusted `unknown`; nothing here throws.
 */
import type { ToolStatus } from "./matrix-events";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const TOOL_STATUSES: readonly ToolStatus[] = ["pending", "in_progress", "completed", "failed"];
export function toolStatus(v: unknown): ToolStatus | undefined {
  return TOOL_STATUSES.includes(v as ToolStatus) ? (v as ToolStatus) : undefined;
}

/** `{content: {type:"text", text}}` → its text, else undefined. */
export function chunkText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  if (!isRecord(content) || content.type !== "text") return undefined;
  return str(content.text);
}
