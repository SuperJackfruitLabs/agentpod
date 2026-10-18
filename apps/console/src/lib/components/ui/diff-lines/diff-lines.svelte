<script lang="ts">
  /**
   * The one diff style (tool-call diffs in chat, the config editor's Changes view): a line
   * diff drawn with the vibe's success and danger tokens. `data-diff` marks each part.
   */
  import { diffLines } from "diff";

  interface Props {
    oldText: string;
    newText: string;
  }

  let { oldText, newText }: Props = $props();

  const parts = $derived(diffLines(oldText, newText));
</script>

{#each parts as part, i (i)}
  {#if part.added}
    <pre data-diff="added" class="m-0 whitespace-pre-wrap break-all rounded px-1 bg-success-wash text-success-text">{part.value}</pre>
  {:else if part.removed}
    <pre data-diff="removed" class="m-0 whitespace-pre-wrap break-all rounded px-1 bg-danger-wash text-destructive line-through">{part.value}</pre>
  {:else}
    <pre data-diff="same" class="m-0 whitespace-pre-wrap break-all px-1 text-muted-foreground">{part.value}</pre>
  {/if}
{/each}
