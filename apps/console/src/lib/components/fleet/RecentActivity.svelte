<script lang="ts">
  import { onMount } from "svelte";
  import { listActivity } from "$lib/api/client";
  import type { ActivityRow } from "$lib/api/client";
  import { relativeTime } from "$lib/utils/relative-time";

  let rows = $state<ActivityRow[]>([]);
  let isLoading = $state(true);

  onMount(async () => {
    try {
      const all = await listActivity();
      rows = all.slice(0, 6);
    } catch {
      // non-fatal: show empty state
    } finally {
      isLoading = false;
    }
  });
</script>

<div class="rounded-lg border p-4 space-y-2" data-testid="recent-activity">
  <div class="flex items-center justify-between">
    <p class="text-sm font-medium">Recent activity</p>
    <a href="/activity" class="text-xs text-primary hover:underline" data-testid="view-all-activity">
      view all →
    </a>
  </div>

  {#if isLoading}
    <p class="text-xs text-muted-foreground">Loading…</p>
  {:else if rows.length === 0}
    <p class="text-xs text-muted-foreground" data-testid="no-activity">No activity yet</p>
  {:else}
    <ul class="space-y-1.5" data-testid="activity-list">
      {#each rows as row (row.id)}
        <li class="flex items-center gap-2 text-xs" data-testid="activity-row">
          <span class="text-foreground font-medium">{row.verb}</span>
          {#if row.stationKey}
            <span class="text-muted-foreground/70">· {row.stationKey}</span>
          {/if}
          {#if row.nodeId}
            <span class="text-muted-foreground/50">· {row.nodeId.slice(0, 8)}</span>
          {/if}
          <span class="ml-auto font-mono text-muted-foreground/50 shrink-0">{relativeTime(String(row.createdAt))}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
