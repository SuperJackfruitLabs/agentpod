<script lang="ts">
  import type { FsEntry } from "@agentpod/contract";
  import { MonacoEditor } from "$lib/components/ui/monaco-editor";
  import { MarkdownViewer } from "$lib/components/ui/markdown";
  import FileIcon from "$lib/components/file-icon.svelte";
  import { BINARY_EXTS, extOf } from "$lib/utils/file-ext";

  interface Props {
    entry: FsEntry;
    content: string | null;
    truncated: boolean;
    loading: boolean;
    error: string | null;
  }

  let { entry, content, truncated, loading, error }: Props = $props();

  const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);
  // A literal NUL byte is the simplest cross-platform signal that a file
  // Monaco would otherwise render as "plaintext" is actually binary data
  // that slipped past the extension check.
  const NUL_BYTE = String.fromCharCode(0);

  const ext = $derived(extOf(entry.name));
  const isBinary = $derived(BINARY_EXTS.has(ext));
  const isMarkdown = $derived(MARKDOWN_EXTS.has(ext));
  const looksBinary = $derived(content !== null && content.includes(NUL_BYTE));

  /** Rendered/Source toggle for markdown files. Resets to Rendered whenever
   *  the previewed file changes. */
  let mdView = $state<"rendered" | "source">("rendered");
  $effect(() => {
    entry.path;
    mdView = "rendered";
  });

  function formatBytes(n: number | null): string {
    if (n === null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`;
    return `${(n / 1_073_741_824).toFixed(2)} GB`;
  }

  function relativeTime(dateStr: string | null): string {
    if (!dateStr) return "unknown";
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diffMs / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
</script>

<div class="flex flex-1 flex-col overflow-hidden">
  {#if truncated}
    <div class="shrink-0 border-b border-border/60 px-3 py-1">
      <span class="rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
        truncated — showing first portion
      </span>
    </div>
  {/if}

  <div class="flex-1 overflow-hidden">
    {#if isBinary}
      <div class="flex h-full items-center justify-center p-6">
        <div class="flex max-w-sm flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
          <FileIcon filename={entry.name} size="lg" />
          <p class="text-sm font-medium text-foreground">{entry.name}</p>
          <p class="text-xs text-muted-foreground">Binary/Image file</p>
          <p class="text-xs text-muted-foreground">
            {formatBytes(entry.size)} · modified {relativeTime(entry.modified)}
          </p>
          <p class="text-[11px] text-muted-foreground/80">
            Preview not available over the station API
          </p>
        </div>
      </div>
    {:else if loading}
      <p class="p-3 text-sm text-muted-foreground">Loading file…</p>
    {:else if error}
      <p class="p-3 text-sm text-destructive">{error}</p>
    {:else if content !== null}
      {#if isMarkdown}
        <div class="flex h-full flex-col">
          <div class="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1.5">
            <button
              type="button"
              class="rounded px-2 py-1 text-[11px] font-medium {mdView === 'rendered' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}"
              aria-pressed={mdView === "rendered"}
              onclick={() => (mdView = "rendered")}
            >
              Rendered
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-[11px] font-medium {mdView === 'source' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}"
              aria-pressed={mdView === "source"}
              onclick={() => (mdView = "source")}
            >
              Source
            </button>
          </div>
          <div class="flex-1 overflow-auto">
            {#if mdView === "rendered"}
              <MarkdownViewer {content} />
            {:else}
              <MonacoEditor code={content} language="markdown" readonly class="h-full" />
            {/if}
          </div>
        </div>
      {:else if looksBinary}
        <div class="p-6 text-sm text-muted-foreground">
          This file contains binary data and can't be previewed as text.
        </div>
      {:else}
        <MonacoEditor code={content} language={ext || "plaintext"} readonly class="h-full" />
      {/if}
    {/if}
  </div>

  {#if content !== null && !isBinary}
    <div class="shrink-0 border-t border-border/60 px-3 py-1 font-mono text-[11px] text-muted-foreground">
      {(isMarkdown ? "markdown" : ext || "plaintext").toUpperCase()} · {formatBytes(entry.size)} · modified {relativeTime(entry.modified)}
    </div>
  {/if}
</div>
