<script lang="ts">
  /**
   * Metric — agent-reported values (CPU, memory, uptime, versions, counts).
   *
   * The mono-for-data rule in one place: any value the agent reported is
   * mono with tabular numerals so digits align down a column; any word the
   * console wrote stays sans. Size/color compose via `class`.
   */
  import { cn } from "$lib/utils";
  import type { Snippet } from "svelte";

  interface Props {
    class?: string;
    children: Snippet;
  }

  let { class: className, children }: Props = $props();
</script>

<span class={cn("font-mono tabular-nums", className)}>{@render children()}</span>
