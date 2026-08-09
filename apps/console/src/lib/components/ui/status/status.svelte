<script lang="ts">
  /**
   * Status — the ONE way status renders in this console.
   *
   * Every status surface (badges, dots, inline labels, ribbon/heatmap cells)
   * goes through this component so all six tokens are always supported, the
   * casing rule is enforced in one place (status is agent-reported data →
   * lowercase mono), and opacity stays at exactly two steps: 10% fills behind
   * text, 100% for dots and cells.
   */
  import { cn } from "$lib/utils";
  import {
    tokenFor,
    statusBadgeClass,
    statusTextClass,
    statusBgClass,
  } from "$lib/utils/status-badge";

  interface Props {
    /** Raw upstream status string (any vocab) — normalized via tokenFor. */
    status: string;
    /**
     * badge = outline chip with 10% fill · text = colored mono label ·
     * dot = solid circle with sr-only label · cell = solid square for ribbons.
     */
    form?: "badge" | "text" | "dot" | "cell";
    /** Visible/accessible label override; defaults to the raw status, lowercased. */
    label?: string;
    /** Pulse the dot while a transition is in flight (motion-safe). */
    animate?: boolean;
    class?: string;
  }

  let { status, form = "badge", label, animate = false, class: className }: Props = $props();

  const token = $derived(tokenFor(status));
  const display = $derived((label ?? status).toLowerCase());
</script>

{#if form === "badge"}
  <span
    data-status={token}
    class={cn(
      "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 font-mono text-xs lowercase",
      statusBadgeClass(status),
      className,
    )}>{display}</span
  >
{:else if form === "text"}
  <span data-status={token} class={cn("font-mono lowercase", statusTextClass(status), className)}
    >{display}</span
  >
{:else if form === "dot"}
  <span data-status={token} class={cn("inline-flex shrink-0", className)}>
    <span
      class={cn(
        "size-2 rounded-full transition-colors duration-200",
        statusBgClass(status),
        animate && "motion-safe:animate-pulse",
      )}
      aria-hidden="true"
    ></span>
    <span class="sr-only">{display}</span>
  </span>
{:else}
  <span
    data-status={token}
    role="img"
    aria-label={display}
    class={cn("block rounded-[2px] transition-colors duration-200", statusBgClass(status), className)}
  ></span>
{/if}
