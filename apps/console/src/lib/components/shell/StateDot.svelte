<script module lang="ts">
  import type { StateId } from "$lib/fleet/state";

  // Tailwind's JIT scanner needs the full class name present verbatim in
  // source — `bg-status-${token}` string interpolation would never get
  // generated. status-badge.ts solves the same problem for the old status
  // vocab; this is the equivalent literal lookup for StateId.
  export const STATE_BG_CLASS: Record<StateId, string> = {
    running: "bg-status-running",
    starting: "bg-status-starting",
    unknown: "bg-status-unknown",
    error: "bg-status-error",
    sleeping: "bg-status-sleeping",
    stopped: "bg-status-stopped",
  };
</script>

<script lang="ts">
  /**
   * StateDot — the one way fleet state renders as a dot.
   *
   * Colour is never the only carrier (constraint 6): the label is always
   * available via `title`, and either shown inline (`withLabel`) or kept for
   * assistive tech via an sr-only span so the dot is never announced as
   * nothing more than a coloured circle.
   */
  import type { StateInfo } from "$lib/fleet/state";
  import { cn } from "$lib/utils";

  interface Props {
    state: StateInfo;
    withLabel?: boolean;
    /** Motion-safe under prefers-reduced-motion via app.css's .animate-pulse override. */
    pulse?: boolean;
    size?: "sm" | "md";
  }

  let { state, withLabel = false, pulse = false, size = "md" }: Props = $props();
</script>

<span class="inline-flex items-center gap-1.5" title={state.label}>
  <span
    aria-hidden="true"
    class={cn(
      "inline-block shrink-0 rounded-full",
      STATE_BG_CLASS[state.token],
      size === "sm" ? "size-1.5" : "size-2",
      pulse && "animate-pulse",
    )}
  ></span>
  {#if withLabel}
    <span class="text-sm">{state.label}</span>
  {:else}
    <span class="sr-only">{state.label}</span>
  {/if}
</span>
