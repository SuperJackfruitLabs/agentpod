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

/** The repository moved to the organization; the old personal path only works by redirect. */
export const INSTALLER_URL = "https://github.com/SuperJackfruitLabs/agentpod/releases/latest/download/install.sh";

export function enrollmentCommand(hubUrl: string, token: string): string {
  return `curl -fsSL ${INSTALLER_URL} | sudo bash -s -- ${hubUrl} ${token}`;
}

/** The hub a new node should dial: the console's own override, else the one it was built for. */
export function enrollmentHubUrl(): string {
  const stored = typeof window !== "undefined" ? window.localStorage.getItem("agentpod.apiUrl") : null;
  return stored ?? import.meta.env.PUBLIC_HUB_URL ?? "http://localhost:3001";
}
