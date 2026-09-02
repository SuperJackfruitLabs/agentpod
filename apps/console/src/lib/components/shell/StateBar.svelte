<script lang="ts">
  /**
   * StateBar — the stacked fleet-state bar.
   *
   * One flex-basis-proportional segment per non-zero state, worst-first
   * (STATE_ORDER), with a legend below carrying the dot + word + count that
   * a bare coloured segment can't (constraint 6). Each segment and each
   * legend row is a button so a click can filter the roster down to that
   * state — the caller decides what `onselect` does.
   */
  import type { StateId } from "$lib/fleet/state";
  import { STATE, STATE_ORDER } from "$lib/fleet/state";
  import { STATE_BG_CLASS } from "./StateDot.svelte";
  import StateDot from "./StateDot.svelte";
  import { cn } from "$lib/utils";

  interface Props {
    counts: Partial<Record<StateId, number>>;
    onselect?: (state: StateId) => void;
  }

  let { counts, onselect }: Props = $props();

  const total = $derived(STATE_ORDER.reduce((sum, id) => sum + (counts[id] ?? 0), 0));

  // A segment under 7% of the bar's width can't fit its count legibly —
  // the legend below carries it instead.
  const MIN_LABEL_PCT = 7;

  const segments = $derived(
    STATE_ORDER.filter((id) => (counts[id] ?? 0) > 0).map((id) => {
      const count = counts[id] ?? 0;
      return { id, info: STATE[id], count, pct: total > 0 ? (count / total) * 100 : 0 };
    }),
  );
</script>

<div class="w-full">
  <div
    role="group"
    aria-label="Fleet state"
    class="flex h-3 w-full overflow-hidden rounded-full bg-muted"
  >
    {#each segments as seg (seg.id)}
      <button
        type="button"
        title="{seg.info.label}: {seg.count}"
        class={cn(
          "flex items-center justify-center overflow-hidden text-[10px] font-mono text-background transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
          STATE_BG_CLASS[seg.info.token],
        )}
        style="flex-basis: {seg.pct}%; flex-grow: 0; flex-shrink: 0;"
        onclick={() => onselect?.(seg.id)}
      >
        {#if seg.pct > MIN_LABEL_PCT}
          {seg.count}
        {/if}
      </button>
    {/each}
  </div>

  <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
    {#each segments as seg (seg.id)}
      <li>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          onclick={() => onselect?.(seg.id)}
        >
          <StateDot state={seg.info} withLabel size="sm" />
          <span class="font-mono text-xs text-muted-foreground">{seg.count}</span>
        </button>
      </li>
    {/each}
  </ul>
</div>
