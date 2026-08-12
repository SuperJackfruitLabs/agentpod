/**
 * status-badge.ts
 *
 * Theme-robust status helpers built on the `--status-*` design tokens
 * (Plan A: app.css defines `--status-running/degraded/starting/stopped/
 * error/sleeping` for light+dark, mapped to Tailwind via `--color-status-*`;
 * the theme store writes them per-scheme from the five `cyber-*` accents).
 *
 * All three exports are literal lookups — never string interpolation — so
 * every class stays Tailwind-scannable (JIT needs full class names present
 * verbatim in source).
 *
 * Usage:
 *   import { statusBadgeClass } from "$lib/utils/status-badge";
 *   <Badge variant="outline" class={statusBadgeClass(node.status)}>{node.status}</Badge>
 */

export type StatusToken = "running" | "degraded" | "starting" | "stopped" | "error" | "sleeping";

/**
 * Maps any status string (node status, agent/station status, or anything
 * else that flows through the shared status vocab) onto one of the six
 * canonical status tokens. Exported so callers that need to rank/group by
 * status token (e.g. AgentTable's status-severity sort) reuse this exact
 * classification instead of re-deriving it.
 */
export function tokenFor(status: string): StatusToken {
  switch (status.toLowerCase()) {
    case "running":
    case "online":
    case "healthy":
    case "active":
    case "connected":
      return "running";

    case "error":
    case "unhealthy":
    case "crashed":
    case "banned":
      return "error";

    case "starting":
    case "stopping":
    case "warning":
    case "pending":
      return "starting";

    case "degraded":
      return "degraded";

    case "sleeping":
    case "hibernated":
    // A runtime the substrate idled out to stop billing it. Not an error and
    // not operator-stopped — it wakes on demand.
    case "asleep":
      return "sleeping";

    // stopped / offline / unknown / anything else
    default:
      return "stopped";
  }
}

/** Outline badge: text + border + 10%-opacity bg, on the status token. */
const BADGE: Record<StatusToken, string> = {
  running: "text-status-running border-status-running bg-status-running/10",
  degraded: "text-status-degraded border-status-degraded bg-status-degraded/10",
  starting: "text-status-starting border-status-starting bg-status-starting/10",
  stopped: "text-status-stopped border-status-stopped bg-status-stopped/10",
  error: "text-status-error border-status-error bg-status-error/10",
  sleeping: "text-status-sleeping border-status-sleeping bg-status-sleeping/10",
};

/** Text-only variant, for inline status labels that don't need a badge shell. */
const TEXT: Record<StatusToken, string> = {
  running: "text-status-running",
  degraded: "text-status-degraded",
  starting: "text-status-starting",
  stopped: "text-status-stopped",
  error: "text-status-error",
  sleeping: "text-status-sleeping",
};

/** Solid background variant, for heatmap cells / dots that carry no text of their own. */
const BG: Record<StatusToken, string> = {
  running: "bg-status-running",
  degraded: "bg-status-degraded",
  starting: "bg-status-starting",
  stopped: "bg-status-stopped",
  error: "bg-status-error",
  sleeping: "bg-status-sleeping",
};

/**
 * Returns the CSS class string for a status badge.
 * Always pair with `variant="outline"` on the Badge component so the base
 * outline badge resets remove conflicting bg/text defaults.
 */
export function statusBadgeClass(status: string): string {
  return BADGE[tokenFor(status)];
}

/** Returns just the text-color class for a status. */
export function statusTextClass(status: string): string {
  return TEXT[tokenFor(status)];
}

/** Returns the solid background-color class for a status. */
export function statusBgClass(status: string): string {
  return BG[tokenFor(status)];
}
