/**
 * A harness permission request (ACP `session/request_permission`) as a decision bound to its
 * subject: charter → "Strict decisions and harness permissions bind their subject" §5.
 *
 * The pure, surface-free half, shared by the two places a request leaves the hub: a station room
 * (permission.v2, `matrix-as/harness-permission.ts`) and a board (the bridge's elicitation post,
 * `bridge/coalesce.ts`). Both must agree on what each option means, on the digest, and on what the
 * person is shown — so it is defined once, here, where the request comes from.
 */

import { createHash } from "node:crypto";

export const HARNESS_PERMISSION_SCHEMA = "harness-permission/v1";

/** How long a person has to answer: the existing board-dispatch bound (charter §5). */
export const PERMISSION_TTL_MS = 30 * 60_000;

export type PermissionMeaning = "approve" | "reject" | "choose";
export type PermissionScope = "once" | "always";

/** ACP's option kinds, and what each means (charter §5). Anything else is a neutral choice. */
const KIND_MEANINGS: Record<string, { meaning: PermissionMeaning; scope: PermissionScope }> = {
  allow_once: { meaning: "approve", scope: "once" },
  allow_always: { meaning: "approve", scope: "always" },
  reject_once: { meaning: "reject", scope: "once" },
  reject_always: { meaning: "reject", scope: "always" },
};

/** What an ACP option kind means, and how far it reaches; a neutral choice for any other kind. */
export function permissionKindMeaning(kind: unknown): { meaning: PermissionMeaning; scope?: PermissionScope } {
  return (typeof kind === "string" ? KIND_MEANINGS[kind] : undefined) ?? { meaning: "choose" };
}

/** Recursively sorted-key JSON, no whitespace; array order kept. The digest's encoding. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The digest of a request: sha256 hex of the canonical `{session_id, request_seq, tool_call,
 * options}`, over the FULL ACP data — not the preview. Two requests that differ in anything the
 * harness sent have different digests, so an answer can be bound to exactly what was asked.
 */
export function permissionDigest(sessionId: string, requestSeq: number, toolCall: unknown, options: unknown): string {
  const canonical = canonicalJson({ session_id: sessionId, request_seq: requestSeq, tool_call: toolCall ?? null, options: options ?? [] });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The request id an answer is addressed to, and the subject's id. */
export const permissionRequestId = (sessionId: string, requestSeq: number): string => `${sessionId}:${requestSeq}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A command, from ACP's `rawInput`: a string, or an argv joined by spaces. */
function commandOf(rawInput: Record<string, unknown>): string | null {
  const c = rawInput.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((part) => typeof part === "string")) return c.join(" ");
  return null;
}

export type PermissionPreviewBlock =
  | { type: "text"; label?: string; text: string }
  | { type: "field"; label: string; value: string };

/**
 * The preview blocks a person must see before approving: the tool's title and kind, its command or
 * raw input, each diff's path and new text, and the locations it touches (charter §5). `drawn` is
 * false when the tool call carries something this cannot show (a terminal, an image): the preview
 * is then incomplete however short it is. Unbounded: each surface bounds it for its own wire.
 */
export function permissionPreview(toolCall: unknown): { blocks: PermissionPreviewBlock[]; drawn: boolean } {
  const tc = isRecord(toolCall) ? toolCall : {};
  const blocks: PermissionPreviewBlock[] = [];
  let drawn = true;
  blocks.push({ type: "field", label: "Tool", value: typeof tc.title === "string" && tc.title !== "" ? tc.title : "an action" });
  if (typeof tc.kind === "string" && tc.kind !== "") blocks.push({ type: "field", label: "Kind", value: tc.kind });
  if (tc.rawInput !== undefined && tc.rawInput !== null) {
    const command = isRecord(tc.rawInput) ? commandOf(tc.rawInput) : null;
    blocks.push(
      command !== null
        ? { type: "text", label: "Command", text: command }
        : { type: "text", label: "Input", text: JSON.stringify(tc.rawInput, null, 2) },
    );
  }
  for (const item of Array.isArray(tc.content) ? tc.content : []) {
    if (isRecord(item) && item.type === "diff" && typeof item.path === "string" && typeof item.newText === "string") {
      blocks.push({ type: "text", label: item.path, text: item.newText });
    } else if (isRecord(item) && item.type === "content" && isRecord(item.content) && item.content.type === "text" && typeof item.content.text === "string") {
      blocks.push({ type: "text", label: "Detail", text: item.content.text });
    } else {
      drawn = false;
    }
  }
  for (const loc of Array.isArray(tc.locations) ? tc.locations : []) {
    if (!isRecord(loc) || typeof loc.path !== "string") {
      drawn = false;
      continue;
    }
    const line = typeof loc.line === "number" ? `:${loc.line}` : "";
    blocks.push({ type: "field", label: "Location", value: `${loc.path}${line}` });
  }
  return { blocks, drawn };
}

/** A `harness-permission/v1` subject in the charter's snake_case spelling, before any surface bounds it. */
export interface HarnessPermissionSubject {
  schema: typeof HARNESS_PERMISSION_SCHEMA;
  id: string;
  digest: string;
  revision: 1;
  expires_at: string;
  preview: PermissionPreviewBlock[];
  preview_complete: boolean;
}

/**
 * The subject of a request off a session event. The digest is over the data as it crossed the
 * wire: a JSON round trip drops what JSON cannot carry, so the same request digests the same
 * wherever it is recomputed. `askedAt` starts the 30-minute expiry.
 */
export function harnessPermissionSubject(
  sessionId: string,
  requestSeq: number,
  payload: unknown,
  askedAt: Date,
): { subject: HarnessPermissionSubject; toolCall: unknown; options: unknown } {
  const p = isRecord(payload) ? payload : {};
  const toolCall: unknown = p.toolCall === undefined ? null : JSON.parse(JSON.stringify(p.toolCall));
  const options: unknown = p.options === undefined ? [] : JSON.parse(JSON.stringify(p.options));
  const preview = permissionPreview(toolCall);
  return {
    toolCall,
    options,
    subject: {
      schema: HARNESS_PERMISSION_SCHEMA,
      id: permissionRequestId(sessionId, requestSeq),
      digest: permissionDigest(sessionId, requestSeq, toolCall, options),
      revision: 1,
      expires_at: new Date(askedAt.getTime() + PERMISSION_TTL_MS).toISOString(),
      preview: preview.blocks,
      preview_complete: preview.drawn,
    },
  };
}

/** When a request was made: the event's own time, or now when it carries none readable. */
export function requestedAt(createdAt: unknown): Date {
  const at = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  return Number.isNaN(at) ? new Date() : new Date(at);
}
