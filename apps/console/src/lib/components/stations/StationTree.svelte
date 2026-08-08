<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronRight, ChevronDown } from "@lucide/svelte";
  import type { StationRow } from "$lib/api/client";
  import HarnessBadge from "$lib/components/fleet/HarnessBadge.svelte";

  interface Props {
    stations: StationRow[];
    nodeId: string;
  }

  let { stations, nodeId }: Props = $props();

  const roots = $derived(stations.filter((s) => s.parentStationId == null));

  function childrenOf(parentId: string): StationRow[] {
    return stations.filter((s) => s.parentStationId === parentId);
  }

  // Start with all parent nodes (nodes that have at least one child) expanded.
  // untrack: intentionally captures initial prop value only — openIds is user-interaction state.
  let openIds = $state<Set<string>>(
    untrack(() =>
      new Set(
        stations
          .filter((s) => s.parentStationId !== null)
          .map((s) => s.parentStationId as string)
      )
    )
  );

  function toggle(id: string) {
    const next = new Set(openIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    openIds = next;
  }
</script>

{#snippet stationNode(station: StationRow, depth: number)}
  {@const children = childrenOf(station.id)}
  {@const hasChildren = children.length > 0}
  {@const isOpen = openIds.has(station.id)}

  <div data-station-id={station.id} class="flex flex-col">
    <div
      class="flex items-center gap-1.5 py-1.5 rounded-md hover:bg-muted/50 transition-colors group"
      style:padding-left="{depth * 16 + 8}px"
    >
      {#if hasChildren}
        <button
          type="button"
          class="flex items-center justify-center w-6 h-6 p-0 bg-transparent border-0 cursor-pointer shrink-0 text-muted-foreground"
          onclick={() => toggle(station.id)}
          aria-expanded={isOpen}
        >
          {#if isOpen}
            <ChevronDown class="w-3 h-3" />
          {:else}
            <ChevronRight class="w-3 h-3" />
          {/if}
        </button>
      {:else}
        <span class="inline-block w-5 shrink-0"></span>
      {/if}

      <a
        href="/nodes/{nodeId}/stations/{station.id}"
        class="flex items-center gap-2 flex-1 min-w-0 no-underline text-inherit"
      >
        <span class="text-sm font-medium truncate group-hover:text-foreground transition-colors">
          {station.displayName}
        </span>
        <div class="flex items-center gap-1 shrink-0 ml-auto">
          <HarnessBadge harness={station.harness} />
          <span class="text-xs text-muted-foreground">{station.kind}</span>
        </div>
      </a>
    </div>

    {#if hasChildren && isOpen}
      <div class="flex flex-col gap-0.5">
        {#each children as child (child.id)}
          {@render stationNode(child, depth + 1)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="flex flex-col gap-0.5 rounded-xl border bg-card p-2">
  {#if roots.length === 0}
    <p class="text-sm text-muted-foreground p-2">No agents added.</p>
  {:else}
    {#each roots as root (root.id)}
      {@render stationNode(root, 0)}
    {/each}
  {/if}
</div>
