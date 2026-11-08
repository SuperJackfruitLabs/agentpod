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

import { z } from "zod";

import {
  HARNESS_PERMISSION_SCHEMA,
  PERMISSION_TTL_MS,
  canonicalJson,
  harnessPermissionSubject,
  permissionKindMeaning,
  permissionPreview,
  permissionRequestId,
} from "../acp";
import { subjectV2, type GateOptionMeaning, type GateSubjectV2 } from "./gate-wire";
import { bindingOf, referenceOf } from "./question-answer";
import type { OptionScope } from "./question-wire";

export { HARNESS_PERMISSION_SCHEMA, PERMISSION_TTL_MS, canonicalJson, permissionPreview, permissionRequestId };

export const PERMISSION_V2_SUITE_TYPE = "dev.agentpod.permission.v2";
export const PERMISSION_ANSWER_V2_SUITE_TYPE = "dev.agentpod.permission.answer.v2";
/**
 * The receipt that closes a permission card. AgentPod's own, because gate.outcome.v1 is keyed by a
 * board and a gate, and a harness permission has neither.
 */
export const PERMISSION_OUTCOME_TYPE = "dev.agentpod.permission.outcome.v1";

/** One option of a permission.v2, as it rides on the Matrix wire. */
export interface PermissionOptionV2 {
  id: string;
  label: string;
  meaning: GateOptionMeaning;
  scope?: OptionScope;
}

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
    const mapped = permissionKindMeaning(o.kind);
    out.push({
      id: o.optionId,
      label: o.name.length > 200 ? `${o.name.slice(0, 199)}…` : o.name,
      meaning: mapped.meaning,
      ...(mapped.scope ? { scope: mapped.scope } : {}),
    });
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
  const raw = harnessPermissionSubject(sessionId, requestSeq, payload, requestedAt);
  // Re-bounded by gate.v2's own helper: the same bounds, the same byte budget, the same rule.
  const subject = subjectV2({ ...raw.subject, expiresAt: raw.subject.expires_at, previewComplete: raw.subject.preview_complete });
  if (!subject) return null;
  const tc = isRecord(raw.toolCall) ? raw.toolCall : {};
  return {
    requestId: subject.id,
    sessionId,
    requestSeq,
    title: typeof tc.title === "string" && tc.title !== "" ? tc.title : "an action",
    toolKind: typeof tc.kind === "string" && tc.kind !== "" ? tc.kind : null,
    options: permissionOptionsV2(raw.options),
    subject,
    expiresAt: new Date(requestedAt.getTime() + PERMISSION_TTL_MS),
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
