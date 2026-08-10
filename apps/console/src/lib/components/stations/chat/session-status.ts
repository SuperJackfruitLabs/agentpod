/**
 * session-status.ts
 *
 * ACP session vocab → the console's six shared status tokens.
 *
 * `tokenFor` (status-badge.ts) knows the fleet vocab, not this one: "idle"
 * means *ready* for an ACP session but falls through to "stopped" there, and
 * "working"/"waiting" have no fleet equivalent at all. Both the chat header and
 * the session-history dialog render the same rows, so the mapping lives here
 * rather than being copied — two maps drifting apart would colour the same
 * session differently in two surfaces on the same screen.
 *
 * Pair it with `label` when rendering `<Status>`, so the visible word stays the
 * session's own status ("idle") rather than the token it maps to ("running").
 */

import type { AcpSessionStatus } from "@agentpod/contract";

export const ACP_STATUS_TOKEN: Record<AcpSessionStatus, string> = {
  starting: "starting",
  working: "starting",
  idle: "running",
  waiting: "degraded",
  ended: "stopped",
};

/**
 * A session's display name: its title (the first prompt, trimmed + truncated by
 * the hub) when it has one, else the caller's fallback.
 *
 * Titles are UNTRUSTED text — user- or agent-authored — so they are only ever
 * interpolated as text, never as markup, and a whitespace-only title counts as
 * no title at all (the hub trims, but an older hub might not). No ellipsis is
 * appended: the hub truncates without one and there is no way to tell a title
 * that was cut from one that happened to be 80 chars long, so overflow is CSS's
 * job (`truncate`).
 */
export function sessionName(
  session: { title?: string | null },
  fallback: string,
): string {
  const title = session.title?.trim();
  return title !== undefined && title.length > 0 ? title : fallback;
}
