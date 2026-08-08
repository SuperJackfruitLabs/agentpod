<script lang="ts">
  import { onMount } from "svelte";
  import { readFile, writeFile } from "$lib/api/client";
  import { diffLines } from "diff";
  import { MonacoEditor } from "$lib/components/ui/monaco-editor";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";

  interface Props {
    stationId: string;
    path: string;
    onClose?: () => void;
    /** Called after a successful save so callers (e.g. FileBrowser, via the
     *  station page) can evict any stale cached content for this path. */
    onSaved?: (path: string) => void;
  }

  let { stationId, path, onClose, onSaved }: Props = $props();

  // ── State ────────────────────────────────────────────────────────────────────
  let original = $state("");
  let buffer = $state("");
  let isLoading = $state(true);
  let loadError = $state<string | null>(null);
  let showConfirm = $state(false);
  let isSaving = $state(false);
  let saveError = $state<string | null>(null);
  let backupPath = $state<string | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const hasChanges = $derived(buffer !== original);

  const diff = $derived(
    hasChanges ? diffLines(original, buffer) : []
  );

  // ── Language detection ───────────────────────────────────────────────────────
  function getLanguage(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "plaintext";
    return ext;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  onMount(async () => {
    try {
      const result = await readFile(stationId, path);
      original = result.content;
      buffer = result.content;
    } catch (err) {
      loadError = err instanceof Error ? err.message : "Failed to load file";
    } finally {
      isLoading = false;
    }
  });

  // ── Handlers ─────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!hasChanges) return;
    isSaving = true;
    saveError = null;
    try {
      const result = await writeFile(stationId, path, buffer, { backup: true });
      original = buffer;
      backupPath = result.backupPath ?? null;
      onSaved?.(path);
    } catch (err) {
      saveError = err instanceof Error ? err.message : "Failed to save";
    } finally {
      isSaving = false;
      showConfirm = false;
    }
  }
</script>

<div class="flex flex-col h-full min-h-[400px] overflow-hidden rounded-md border border-border bg-background">
  <!-- ── Header ── -->
  <div class="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-muted/5 shrink-0 text-xs font-mono">
    <span class="truncate text-foreground">{path}</span>
    <div class="ml-auto flex items-center gap-2 shrink-0">
      {#if backupPath}
        <span class="text-[11px] text-muted-foreground font-sans">
          Backup: <span class="font-mono">{backupPath}</span>
        </span>
      {/if}
      {#if saveError}
        <span class="text-[11px] text-destructive font-sans">{saveError}</span>
      {/if}
      {#if onClose}
        <Button
          variant="outline"
          size="sm"
          class="h-7 px-2 text-[11px] font-sans"
          onclick={onClose}
        >
          Close
        </Button>
      {/if}
      <Button
        variant="default"
        size="sm"
        class="h-7 px-2 text-[11px] font-sans"
        disabled={!hasChanges || isSaving}
        onclick={() => (showConfirm = true)}
      >
        {isSaving ? "Saving…" : "Save"}
      </Button>
    </div>
  </div>

  <!-- ── Body ── -->
  {#if isLoading}
    <p class="p-3 text-sm text-muted-foreground">Loading…</p>
  {:else if loadError}
    <p class="p-3 text-sm text-destructive">{loadError}</p>
  {:else}
    <!-- Editor + diff split: editor on top, diff below when changes exist -->
    <div class="flex flex-col flex-1 overflow-hidden">
      <!-- Monaco editor replaces textarea -->
      <div class="flex flex-col flex-1 overflow-hidden" style:flex={hasChanges ? "0 0 50%" : "1 1 100%"}>
        <MonacoEditor
          code={buffer}
          language={getLanguage(path)}
          onchange={(v) => { buffer = v; }}
          onsave={() => { if (hasChanges) showConfirm = true; }}
          class="h-full"
        />
      </div>

      <!-- Diff view — rendered below the editor whenever there are pending changes -->
      {#if hasChanges}
        <div class="flex flex-col flex-1 overflow-auto border-t border-border bg-muted/10">
          <div class="px-3 py-1 text-[11px] font-sans text-muted-foreground border-b border-border/60">
            Diff (original → buffer)
          </div>
          <div
            data-testid="diff-view"
            class="flex-1 overflow-auto p-2 font-mono text-[12px] leading-relaxed"
          >
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
                <pre
                  class="m-0 whitespace-pre-wrap break-all px-1 text-muted-foreground"
                >{part.value}</pre>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- ── Save ConfirmDialog ── -->
<ConfirmDialog
  open={showConfirm}
  title="Save changes to {path}"
  message="Save changes to {path}? A timestamped backup will be created."
  onConfirm={handleSave}
  onCancel={() => (showConfirm = false)}
/>
