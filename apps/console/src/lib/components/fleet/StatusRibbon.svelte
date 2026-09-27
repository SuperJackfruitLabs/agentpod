<script lang="ts" module>
  export interface RibbonItem {
    id: string;
    /** Accessible name, e.g. the agent name. */
    label: string;
    /** Raw status string — normalized via the shared token map. */
    status: string;
    /** Optional rich native tooltip (metrics etc.). */
    title?: string;
  }
</script>

<script lang="ts">
  /**
   * StatusRibbon — the fleet, at a glance, in one strip of status-colored
   * cells. One geometry at three scales:
   *
   *   lg — 20px interactive heatmap cells (Overview)
   *   sm — 8px inline strip (node rows, table group headers)
   *   xs — 3px chrome strip flush under a PageHeader
   *
   * Restraint rules: cells are always 100%-opacity status tokens, the ribbon
   * never animates on load, and `error` cells carry extra visual weight
   * independent of hue (a ring) so red/green confusion can't hide a sick
   * agent — except at xs, where the strip is chrome, not a chart.
   */
  import { cn } from "$lib/utils";
  import { tokenFor, statusBgClass } from "$lib/utils/status-badge";

  interface Props {
    items: RibbonItem[];
    size?: "lg" | "sm" | "xs";
    /** When provided (lg only in practice), cells become buttons. */
    onSelect?: (id: string) => void;
    /** data-testid for each cell; callers that had one before keep their own. */
    cellTestId?: string;
    class?: string;
  }

  let { items, size = "sm", onSelect, cellTestId = "ribbon-cell", class: className }: Props = $props();

  const CELL: Record<"lg" | "sm" | "xs", string> = {
    lg: "size-5 rounded-sm",
    sm: "size-2 rounded-[2px]",
    xs: "h-[3px] w-2 rounded-none",
  };
  const GAP: Record<"lg" | "sm" | "xs", string> = {
    lg: "gap-1",
    sm: "gap-[3px]",
    xs: "gap-px",
  };

  function emphasisClass(status: string): string {
    return tokenFor(status) === "error" && size !== "xs"
      ? "ring-2 ring-status-error/40 ring-offset-1 ring-offset-background"
      : "";
  }
</script>

<div
  class={cn(
    "flex",
    size === "xs" ? "flex-nowrap overflow-hidden" : "flex-wrap",
    GAP[size],
    className,
  )}
  data-testid="status-ribbon"
  data-size={size}
>
  {#each items as item (item.id)}
    {#if onSelect}
      <button
        type="button"
        class={cn(
          CELL[size],
          statusBgClass(item.status),
          emphasisClass(item.status),
          "shrink-0 transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-ring",
        )}
        title={item.title}
        aria-label="{item.label} ({item.status.toLowerCase()})"
        data-testid={cellTestId}
        data-status={item.status.toLowerCase()}
        onclick={() => onSelect(item.id)}
      ></button>
    {:else}
      <span
        role="img"
        class={cn(CELL[size], statusBgClass(item.status), emphasisClass(item.status), "shrink-0")}
        title={item.title}
        aria-label="{item.label} ({item.status.toLowerCase()})"
        data-testid={cellTestId}
        data-status={item.status.toLowerCase()}
      ></span>
    {/if}
  {/each}
</div>
