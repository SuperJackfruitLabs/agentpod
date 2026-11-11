/**
 * A harness permission prompt as permission.v2 carries it. The envelope, its options and its
 * answers are the board-room contract (`@superjackfruitlabs/treaty-matrix-events`); reading the
 * request off an AgentPod session event and timing its expiry stay here.
 *
 * Pure; no database and no Matrix.
 */

import { permissionOptionsV2, subjectV2, type HarnessPermission } from "@superjackfruitlabs/treaty-matrix-events";

import { PERMISSION_TTL_MS, harnessPermissionSubject } from "../acp";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A permission request off a session event, as permission.v2 carries it; null when the subject
 * cannot be carried, or when no option has an id permission.v2 can carry (the contract wants one
 * to twenty). Either way the room then gets the prose and the v1 card alone, as before.
 * `requestedAt` starts the expiry.
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
  const options = permissionOptionsV2(raw.options);
  if (options.length === 0) return null;
  const tc = isRecord(raw.toolCall) ? raw.toolCall : {};
  return {
    requestId: subject.id,
    sessionId,
    requestSeq,
    title: typeof tc.title === "string" && tc.title !== "" ? tc.title : "an action",
    toolKind: typeof tc.kind === "string" && tc.kind !== "" ? tc.kind : null,
    options,
    subject,
    expiresAt: new Date(requestedAt.getTime() + PERMISSION_TTL_MS),
  };
}
