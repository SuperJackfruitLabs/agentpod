<script lang="ts">
  /**
   * DiffBlock — inline line-diff for a tool-call `diff` content block.
   *
   * The rendering (diffLines + green/red 15% fills) is copied from
   * ConfigEditor.svelte's diff view — the ONE sanctioned raw-color exception
   * to the status-token rule. Future shared component: ConfigEditor should
   * eventually render through this too (deliberately not refactored here).
   */
  import { diffLines } from "diff";

  interface Props {
    path: string;
    oldText: string | null;
    newText: string;
  }

  let { path, oldText, newText }: Props = $props();

  const diff = $derived(diffLines(oldText ?? "", newText));
</script>

<div data-testid="diff-block" class="overflow-hidden rounded-md border border-border bg-muted/10">
  <div class="border-b border-border/60 px-2 py-1 font-mono text-xs text-muted-foreground">
    {path}
  </div>
  <div class="overflow-x-auto p-2 font-mono text-xs leading-relaxed">
    {#each diff as part, i (i)}
      {#if part.added}
        <pre
          class="m-0 whitespace-pre-wrap break-all rounded px-1 bg-green-500/15 text-green-700 dark:text-green-400"
        >{part.value}</pre>
      {:else if part.removed}
        <pre
          class="m-0 whitespace-pre-wrap break-all rounded px-1 bg-red-500/15 text-red-700 dark:text-red-400 line-through"
        >{part.value}</pre>
      {:else}
        <pre class="m-0 whitespace-pre-wrap break-all px-1 text-muted-foreground">{part.value}</pre>
      {/if}
    {/each}
  </div>
</div>
