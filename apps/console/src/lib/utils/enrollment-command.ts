/**
 * enrollment-command.ts
 *
 * Single source of truth for the node-enrollment curl one-liner. Previously
 * this exact string was duplicated three times in NodesOverview.svelte: the
 * clipboard-copy handler's template literal, the persistent post-mint card,
 * and the empty-state card. `EnrollmentCommand.svelte` renders it (the two
 * markup copies); `handleCopyEnrollCmd` in NodesOverview builds the same
 * string via this function for `navigator.clipboard.writeText`, so the
 * copied text and the displayed text can never drift apart.
 *
 * Usage:
 *   import { enrollmentCommand } from "$lib/utils/enrollment-command";
 *   const cmd = enrollmentCommand(hubUrl, token);
 */

export function enrollmentCommand(hubUrl: string, token: string): string {
  return `curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh | sudo bash -s -- ${hubUrl} ${token}`;
}
