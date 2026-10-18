<script lang="ts">
  /**
   * The one diff style (tool-call diffs in chat, the config editor's Changes view, the
   * Changes tab's patches): lines drawn with the vibe's success and danger tokens.
   * `data-diff` marks each part. Give it two texts to compare, or a unified `patch`.
   */
  import { diffLines } from "diff";

  interface Props {
    oldText?: string;
    newText?: string;
    /** A unified patch (git diff output), drawn line by line. */
    patch?: string;
  }

  let { oldText = "", newText = "", patch }: Props = $props();

  type Kind = "added" | "removed" | "same" | "hunk";

  const parts = $derived.by((): { kind: Kind; value: string }[] => {
    if (patch === undefined) {
      return diffLines(oldText, newText).map((p) => ({
        kind: p.added ? "added" : p.removed ? "removed" : "same",
        value: p.value,
      }));
    }
    const lines = patch.replace(/\n$/, "").split("\n");
    return lines.map((line) => ({
      kind: line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+") && !line.startsWith("+++")
          ? "added"
          : line.startsWith("-") && !line.startsWith("---")
            ? "removed"
            : "same",
      value: line,
    }));
  });
  const isPatch = $derived(patch !== undefined);
</script>

<div class="ap-diff font-mono text-xs leading-relaxed" data-diff-form={isPatch ? "patch" : "texts"}>
  {#each parts as part, i (i)}
    {#if part.kind === "added"}
      <pre data-diff="added" class="m-0 whitespace-pre-wrap break-all rounded px-1 bg-success-wash text-success-text">{part.value}</pre>
    {:else if part.kind === "removed"}
      <pre data-diff="removed" class="m-0 whitespace-pre-wrap break-all rounded px-1 bg-danger-wash text-destructive {isPatch ? '' : 'line-through'}">{part.value}</pre>
    {:else if part.kind === "hunk"}
      <pre data-diff="hunk" class="m-0 mt-1 whitespace-pre-wrap break-all px-1 text-info-text">{part.value}</pre>
    {:else}
      <pre data-diff="same" class="m-0 whitespace-pre-wrap break-all px-1 text-muted-foreground">{part.value}</pre>
    {/if}
  {/each}
</div>
