<script lang="ts">
  import { onMount } from "svelte";
  import { listActivity } from "$lib/api/client";
  import type { ActivityRow } from "$lib/api/client";
  import PageHeader from "$lib/components/page-header.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";

  let rows = $state<ActivityRow[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  /** Human-readable relative time: "just now", "5m ago", "2h ago", "3d ago" */
  function relativeTime(dateStr: string): string {
    try {
      const diff = Date.now() - new Date(dateStr).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1) return "just now";
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    } catch {
      return "?";
    }
  }

  /** CSS classes for a result badge (ok → status-running, error → status-error, else muted) */
  function resultClass(result: string | undefined): string {
    if (!result) return "text-muted-foreground/50 border-muted-foreground/30 bg-muted/20";
    switch (result.toLowerCase()) {
      case "ok":
        return "text-status-running";
      case "error":
        return "text-status-error";
      default:
        return "text-muted-foreground";
    }
  }

  onMount(async () => {
    try {
      const all = await listActivity();
      rows = all;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load activity";
    } finally {
      isLoading = false;
    }
  });
</script>

<PageHeader title="Activity" subtitle="// fleet event log" />

<div class="container mx-auto px-4 sm:px-6 max-w-7xl py-6">
  {#if isLoading}
    <div class="space-y-2">
      {#each [1, 2, 3, 4, 5] as _}
        <Skeleton class="h-9 rounded-sm" />
      {/each}
    </div>

  {:else if error}
    <div class="cyber-card p-4 border-destructive/50">
      <p class="text-sm font-mono text-destructive">{error}</p>
    </div>

  {:else if rows.length === 0}
    <div class="cyber-card p-6 text-center" data-testid="empty-state">
      <p class="font-mono text-sm text-muted-foreground">// no activity yet</p>
    </div>

  {:else}
    <div class="cyber-card overflow-hidden" data-testid="activity-table">
      <!-- Column header row -->
      <div
        class="grid grid-cols-[1fr_1.5fr_6rem_6rem] gap-x-4 px-4 py-2 border-b border-border/30"
        style="background: hsl(var(--muted) / 0.3);"
      >
        <span class="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Verb</span>
        <span class="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Station / Node</span>
        <span class="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Result</span>
        <span class="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60 text-right">When</span>
      </div>

      <!-- Data rows -->
      <ul class="divide-y divide-border/20">
        {#each rows as row (row.id)}
          <li
            class="grid grid-cols-[1fr_1.5fr_6rem_6rem] gap-x-4 px-4 py-2.5 items-center hover:bg-primary/3 transition-colors"
            data-testid="activity-row"
          >
            <!-- Verb -->
            <span class="font-mono text-xs text-foreground font-medium truncate">{row.verb}</span>

            <!-- Station / Node -->
            <span class="font-mono text-xs text-muted-foreground/80 truncate">
              {#if row.stationKey}
                {row.stationKey}
              {:else if row.nodeId}
                {row.nodeId.slice(0, 8)}
              {:else}
                <span class="text-muted-foreground/40">—</span>
              {/if}
            </span>

            <!-- Result badge -->
            <span>
              {#if row.result}
                <span
                  class="inline-block font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border {resultClass(row.result)}"
                  data-testid="result-badge"
                >
                  {row.result}
                </span>
              {/if}
            </span>

            <!-- Relative time -->
            <span class="font-mono text-[11px] text-muted-foreground/50 text-right whitespace-nowrap">
              {relativeTime(String(row.createdAt))}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
