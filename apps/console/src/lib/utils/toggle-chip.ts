/**
 * toggle-chip.ts
 *
 * Shared class builder for the small toggle-chip buttons used by LogTail's
 * level filter/follow/wrap controls and AgentTable's filter chips: a
 * bordered pill that switches to a tinted "active" look on the given tone.
 *
 * `active`/`tone` branches are full-literal Tailwind class strings (no
 * interpolation) so the classes stay scannable by Tailwind's JIT.
 *
 * Usage:
 *   import { chipClass } from "$lib/utils/toggle-chip";
 *   <button class={chipClass(levelFilter === "error", "error")}>Error</button>
 */

export type ChipTone =
  | "primary"
  | "running"
  | "degraded"
  | "starting"
  | "error"
  | "stopped"
  | "sleeping";

const BASE = "rounded-md border px-2 py-1 whitespace-nowrap transition-colors";
const INACTIVE = "border-border text-muted-foreground hover:text-foreground";

/** Active-state literal per tone — mirrors LogTail's inline chip classes exactly. */
const ACTIVE: Record<ChipTone, string> = {
  primary: "border-primary bg-primary/10 text-primary",
  running: "border-status-running bg-status-running/10 text-status-running",
  degraded: "border-status-degraded bg-status-degraded/10 text-status-degraded",
  starting: "border-status-starting bg-status-starting/10 text-status-starting",
  error: "border-status-error bg-status-error/10 text-status-error",
  stopped: "border-status-stopped bg-status-stopped/10 text-status-stopped",
  sleeping: "border-status-sleeping bg-status-sleeping/10 text-status-sleeping",
};

/** Returns the class string for a toggle-chip button. */
export function chipClass(active: boolean, tone: ChipTone = "primary"): string {
  return `${BASE} ${active ? ACTIVE[tone] : INACTIVE}`;
}
