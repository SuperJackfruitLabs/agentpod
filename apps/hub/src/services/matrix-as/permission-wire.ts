/**
 * permission.v2: a harness permission prompt in AgentPod's own decision envelope.
 *
 * charter → "Strict decisions and harness permissions bind their subject" §5–6. The event namespace
 * follows the judge: superpipeline judges questions and gates, AgentPod judges a harness's ACP
 * `session/request_permission`. The station room's prose message keeps the v1 card it has always
 * carried (`dev.agentpod.permission`) and also carries `suite_event_type: dev.agentpod.permission.v2`:
 * options that say what they mean and how far they reach, and a `harness-permission/v1` subject
 * whose preview shows what the agent would do. The subject is re-bounded by gate.v2's own helper
 * (`subjectV2`), so the bounds and the rule — no approval of an incomplete preview — are the same.
 *
 * Pure; no database and no Matrix.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import { subjectV2, type GateOptionMeaning, type GateSubjectV2 } from "./gate-wire";
import { bindingOf, referenceOf } from "./question-answer";
import type { OptionScope } from "./question-wire";

export const PERMISSION_V2_SUITE_TYPE = "dev.agentpod.permission.v2";
export const PERMISSION_ANSWER_V2_SUITE_TYPE = "dev.agentpod.permission.answer.v2";
/**
 * The receipt that closes a permission card. AgentPod's own, because gate.outcome.v1 is keyed by a
 * board and a gate, and a harness permission has neither.
 */
export const PERMISSION_OUTCOME_TYPE = "dev.agentpod.permission.outcome.v1";
export const HARNESS_PERMISSION_SCHEMA = "harness-permission/v1";

/** How long a person has to answer: the existing board-dispatch bound (charter §5). */
export const PERMISSION_TTL_MS = 30 * 60_000;

/** One option of a permission.v2, as it rides on the Matrix wire. */
export interface PermissionOptionV2 {
  id: string;
  label: string;
  meaning: GateOptionMeaning;
  scope?: OptionScope;
}

/** ACP's option kinds, and what each means here (charter §5). Anything else is a neutral choice. */
const KIND_MEANINGS: Record<string, { meaning: GateOptionMeaning; scope: OptionScope }> = {
  allow_once: { meaning: "approve", scope: "once" },
  allow_always: { meaning: "approve", scope: "always" },
  reject_once: { meaning: "reject", scope: "once" },
  reject_always: { meaning: "reject", scope: "always" },
};

const AcpOption = z.object({ optionId: z.string().min(1).max(200), name: z.string(), kind: z.string().optional() });

/** The options a harness offered, in its order, with meanings; one with no usable id is dropped. */
export function permissionOptionsV2(rawOptions: unknown): PermissionOptionV2[] {
  if (!Array.isArray(rawOptions)) return [];
  const seen = new Set<string>();
  const out: PermissionOptionV2[] = [];
  for (const raw of rawOptions) {
    const parsed = AcpOption.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.optionId)) continue;
    const o = parsed.data;
    seen.add(o.optionId);
    const mapped = o.kind ? KIND_MEANINGS[o.kind] : undefined;
    out.push({
      id: o.optionId,
      label: o.name.length > 200 ? `${o.name.slice(0, 199)}…` : o.name,
      ...(mapped ? { meaning: mapped.meaning, scope: mapped.scope } : { meaning: "choose" }),
    });
  }
  return out;
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A command, from ACP's `rawInput`: a string, or an argv joined by spaces. */
function commandOf(rawInput: Record<string, unknown>): string | null {
  const c = rawInput.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((part) => typeof part === "string")) return c.join(" ");
  return null;
}

/**
 * The preview blocks a person must see before approving: the tool's title and kind, its command or
 * raw input, each diff's path and new text, and the locations it touches (charter §5). `drawn` is
 * false when the tool call carries something this cannot show (a terminal, an image): the preview
 * is then incomplete however short it is.
 */
export function permissionPreview(toolCall: unknown): { blocks: unknown[]; drawn: boolean } {
  const tc = isRecord(toolCall) ? toolCall : {};
  const blocks: unknown[] = [];
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

/** The request id an answer is addressed to: the subject's id. */
export const permissionRequestId = (sessionId: string, requestSeq: number): string => `${sessionId}:${requestSeq}`;

/** Everything permission.v2 needs from a request, and the binding recorded for it. */
export interface HarnessPermission {
  requestId: string;
  sessionId: string;
  requestSeq: number;
  title: string;
  toolKind: string | null;
  options: PermissionOptionV2[];
  subject: GateSubjectV2;
  expiresAt: Date;
}

/**
 * A permission request off a session event, as permission.v2 carries it; null when the subject
 * cannot be carried (it then gets the v1 card alone, as before). `requestedAt` starts the expiry.
 */
export function harnessPermission(
  sessionId: string,
  requestSeq: number,
  payload: unknown,
  requestedAt: Date,
): HarnessPermission | null {
  const p = isRecord(payload) ? payload : {};
  // The digest is over the data as it crossed the wire: a JSON round trip drops what JSON cannot
  // carry, so the same request digests the same wherever it is recomputed.
  const toolCall: unknown = p.toolCall === undefined ? null : JSON.parse(JSON.stringify(p.toolCall));
  const rawOptions: unknown = p.options === undefined ? [] : JSON.parse(JSON.stringify(p.options));
  const expiresAt = new Date(requestedAt.getTime() + PERMISSION_TTL_MS);
  const preview = permissionPreview(toolCall);
  const subject = subjectV2({
    id: permissionRequestId(sessionId, requestSeq),
    digest: permissionDigest(sessionId, requestSeq, toolCall, rawOptions),
    schema: HARNESS_PERMISSION_SCHEMA,
    revision: 1,
    expiresAt: expiresAt.toISOString(),
    preview: preview.blocks,
    previewComplete: preview.drawn,
  });
  if (!subject) return null;
  const tc = isRecord(toolCall) ? toolCall : {};
  return {
    requestId: subject.id,
    sessionId,
    requestSeq,
    title: typeof tc.title === "string" && tc.title !== "" ? tc.title : "an action",
    toolKind: typeof tc.kind === "string" && tc.kind !== "" ? tc.kind : null,
    options: permissionOptionsV2(rawOptions),
    subject,
    expiresAt,
  };
}

/**
 * The permission.v2 fields on the station room's prose message: the marker and the envelope, beside
 * the v1 card the message already carries under `dev.agentpod.permission`. Pinned by the shared
 * fixture.
 */
export function permissionV2Content(p: HarnessPermission): Record<string, unknown> {
  return {
    suite_event_type: PERMISSION_V2_SUITE_TYPE,
    schema_version: 1,
    request_id: p.requestId,
    session_id: p.sessionId,
    request_seq: p.requestSeq,
    title: p.title,
    ...(p.toolKind ? { tool_kind: p.toolKind } : {}),
    options: p.options,
    subject: p.subject,
  };
}

// ── The answer ───────────────────────────────────────────────────────────────

const ID_MAX = 600;

export interface ParsedPermissionAnswer {
  requestId: string;
  optionId: string;
  subject: { id: string; digest: string } | null;
  referencedEventId: string | null;
}

/**
 * Read a permission.answer.v2 out of an `m.room.message`, or null when it is not one. Any message
 * marked as one is never a prompt, whether or not it parses — the caller checks the marker first.
 */
export function parsePermissionAnswer(content: unknown): ParsedPermissionAnswer | null {
  if (!isPermissionAnswerMarked(content)) return null;
  const requestId = content.request_id;
  const optionId = content.option_id;
  if (typeof requestId !== "string" || requestId === "" || requestId.length > ID_MAX) return null;
  if (typeof optionId !== "string" || optionId === "" || optionId.length > ID_MAX) return null;
  return { requestId, optionId, subject: bindingOf(content), referencedEventId: referenceOf(content) };
}

/** Does this message say it is a permission.answer.v2? */
export function isPermissionAnswerMarked(content: unknown): content is Record<string, unknown> {
  return isRecord(content) && content.suite_event_type === PERMISSION_ANSWER_V2_SUITE_TYPE;
}

// ── The outcome ──────────────────────────────────────────────────────────────

export type PermissionOutcome = "selected" | "expired" | "cancelled";

/**
 * The structured receipt that closes a permission card, pointing at the prose message the card was
 * drawn from. `decided_by` is the person's label, never an mxid; null when nobody in the room did.
 */
export function permissionOutcomeContent(
  p: { requestId: string; sessionId: string; requestSeq: number; eventId: string },
  outcome: PermissionOutcome,
  optionId: string | null,
  decidedBy: string | null,
): Record<string, unknown> {
  return {
    suite_event_type: PERMISSION_OUTCOME_TYPE,
    request_id: p.requestId,
    session_id: p.sessionId,
    request_seq: p.requestSeq,
    outcome,
    option_id: optionId,
    decided_by: decidedBy,
    "m.relates_to": { rel_type: "m.reference", event_id: p.eventId },
  };
}

/** The prose line beside the receipt. */
export function permissionOutcomeText(outcome: PermissionOutcome, optionLabel: string | null, decidedBy: string | null): string {
  if (outcome === "expired") return "That permission request expired unanswered, so the agent was told it was not given.";
  if (outcome === "cancelled") return "That permission request was withdrawn.";
  const what = optionLabel ?? "Answered";
  return decidedBy ? `${what} — answered by ${decidedBy}.` : `${what} — answered.`;
}
