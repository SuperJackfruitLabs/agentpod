<script lang="ts">
  /**
   * DiffBlock — inline line-diff for a tool-call `diff` content block.
   *
   * The lines are the shared DiffLines (the config editor's Changes view uses
   * the same), drawn with the vibe's success and danger tokens.
   */
  import { DiffLines } from "$lib/components/ui/diff-lines";

  interface Props {
    path: string;
    oldText: string | null;
    newText: string;
  }

  let { path, oldText, newText }: Props = $props();
</script>

<div data-testid="diff-block" class="overflow-hidden rounded-md border border-border bg-muted/10">
  <div class="border-b border-border/60 px-2 py-1 font-mono text-xs text-muted-foreground">
    {path}
  </div>
  <div class="overflow-x-auto p-2 font-mono text-xs leading-relaxed">
    <DiffLines oldText={oldText ?? ""} {newText} />
  </div>
</div>
