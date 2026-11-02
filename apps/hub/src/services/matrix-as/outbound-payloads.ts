/** Reading the ACP events a room path receives: chunks, permission requests, errors. */

import type { PermissionOption } from "./permissions";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The text of an `agent_message_chunk`, or undefined for anything else. */
export function messageChunkText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  // Thought chunks are deliberately excluded *from the room*: reasoning
  // belongs in the console's transcript, not in a room people share, where it
  // would turn one answer into a monologue. They are streamed to the reader's
  // own devices instead — see `streamThought`, which makes them watchable
  // without making them permanent.
  if (payload.sessionUpdate !== "agent_message_chunk") return undefined;
  const content = payload.content;
  if (!isRecord(content) || content.type !== "text") return undefined;
  return typeof content.text === "string" ? content.text : undefined;
}

/** The text of a chunk of the given kind, or undefined for anything else. */
export function chunkTextOfKind(payload: unknown, kind: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.sessionUpdate !== kind) return undefined;
  const content = payload.content;
  if (!isRecord(content) || content.type !== "text") return undefined;
  return typeof content.text === "string" ? content.text : undefined;
}

/** What an agent is asking to do, and the answers it will accept. */
export function permissionRequest(payload: unknown): {
  title: string;
  options: PermissionOption[];
} | null {
  if (!isRecord(payload)) return null;
  const toolCall = isRecord(payload.toolCall) ? payload.toolCall : {};
  const title = typeof toolCall.title === "string" ? toolCall.title : "an action";

  // Both halves or neither: an option the room can name but not answer with
  // would be worse than one it never showed.
  const options = Array.isArray(payload.options)
    ? payload.options
        .map((o) =>
          isRecord(o) && typeof o.name === "string" && typeof o.optionId === "string"
            ? { optionId: o.optionId, name: o.name }
            : null
        )
        .filter((o): o is PermissionOption => o !== null)
    : [];

  return { title, options };
}

/** An error event's words, or "unknown". */
export function errorMessage(payload: unknown): string {
  const message = isRecord(payload) ? payload.message : undefined;
  return String(message ?? "unknown");
}
