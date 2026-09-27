<script lang="ts">
  /**
   * AttentionLane — the one strip that holds only things needing a human.
   *
   * Its proudest state is empty, so the empty state is words, not a blank
   * row. Items are anchors rather than buttons: every AttentionItem carries
   * an href, and a real link keeps middle-click, focus order and the status
   * bar that a click handler on a <button> throws away.
   */
  import type { AttentionItem } from "$lib/fleet/attention";
  import { STATE } from "$lib/fleet/state";
  import { cn } from "$lib/utils";
  import StateDot from "./StateDot.svelte";

  interface Props {
    items: AttentionItem[];
  }

  let { items }: Props = $props();
</script>

<section
  data-testid="attention-lane"
  aria-label="Needs you"
  class="flex min-w-0 items-stretch border-b border-border bg-card"
>
  <div class="flex shrink-0 items-center gap-2 border-r border-border px-3 py-1.5">
    <span class="text-[11px] font-medium tracking-[0.14em] text-muted-foreground">NEEDS YOU</span>
    <span
      data-testid="attention-count"
      class={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums",
        items.length > 0
          ? "bg-status-unknown text-background"
          : "border border-border text-muted-foreground",
      )}
      aria-live="polite"
    >{items.length}</span>
  </div>

  {#if items.length === 0}
    <p class="flex items-center px-3 py-1.5 text-sm text-muted-foreground">
      Nothing needs you. The fleet is running itself.
    </p>
  {:else}
    <!-- min-w-0 is what keeps this scroller from setting the shell's width to
         its own content width and shoving the context rail off screen. -->
    <div
      data-testid="attention-items"
      class="flex min-w-0 flex-1 overflow-x-auto"
    >
      {#each items as item (item.kind + item.who)}
        <!--
          `relative` is load-bearing, not styling. StateDot's sr-only label is
          position:absolute; with no positioned ancestor its containing block is
          the initial one, so it escapes this scroller's clip entirely and adds
          its static x-position to the DOCUMENT's scroll width — measured at
          1828px on a 1500px viewport with five real items, past every
          overflow:hidden in the shell. Making the item the containing block
          puts the label back inside the scroller.
        -->
        <a
          data-testid="attention-item"
          href={item.href}
          class="relative flex shrink-0 items-center gap-2 whitespace-nowrap border-r border-border px-3 py-1.5 transition-colors hover:bg-muted focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-foreground"
        >
          <StateDot state={STATE[item.token]} size="sm" />
          <span class="text-sm text-foreground">{item.what}</span>
          <span class="font-mono text-xs text-foreground">{item.who}</span>
          <span class="text-xs text-muted-foreground">{item.detail}</span>
        </a>
      {/each}
    </div>
  {/if}
</section>
