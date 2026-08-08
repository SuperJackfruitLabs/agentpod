<script lang="ts">
  import { onMount } from "svelte";
  import { activity } from "$lib/api/client";
  import type { StationAuditRow } from "$lib/api/client";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Empty } from "$lib/components/ui/empty";
  import * as Card from "$lib/components/ui/card";

  interface Props {
    stationId: string;
  }

  let { stationId }: Props = $props();

  let rows = $state<StationAuditRow[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    isLoading = true;
    error = null;
    try {
      rows = await activity(stationId);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load activity";
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    load();
  });

  function fmtTimestamp(val: string | Date): string {
    const d = typeof val === "string" ? new Date(val) : val;
    if (isNaN(d.getTime())) return String(val);
    const diffMs = Date.now() - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toLocaleString();
  }

  // The hub returns paramsSummary as a jsonb OBJECT; older rows/mocks may be
  // strings. Render objects as compact JSON, hide empty ones.
  function fmtParams(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === "string") return value || null;
    const json = JSON.stringify(value);
    return json === "{}" ? null : json;
  }

  function resultBadgeClass(result: string): string {
    if (result === "ok") return "text-status-running border-status-running bg-status-running/10";
    if (result === "error") return "text-status-error border-status-error bg-status-error/10";
    return "text-status-stopped border-status-stopped bg-status-stopped/10";
  }
</script>

<div class="flex flex-col gap-3 p-4">
  <!-- Toolbar -->
  <div class="flex justify-end">
    <Button variant="outline" size="sm" disabled={isLoading} onclick={load} aria-label="Refresh">
      Refresh
    </Button>
  </div>

  {#if isLoading}
    <div class="flex flex-col gap-2">
      <p class="text-sm text-muted-foreground">Loading activity…</p>
      <Skeleton class="h-9 w-full rounded-md" />
      <Skeleton class="h-9 w-full rounded-md" />
      <Skeleton class="h-9 w-full rounded-md" />
    </div>
  {:else if error}
    <p class="text-sm text-destructive py-2">{error}</p>
  {:else if rows.length === 0}
    <Empty title="No activity yet" />
  {:else}
    <Card.Root class="overflow-hidden border-border/60">
      <ul class="divide-y divide-border/40">
        {#each rows as row (row.id)}
          <li
            class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-4 py-2.5 text-sm transition-colors hover:bg-muted/40"
            data-testid="activity-row"
          >
            <span
              class="min-w-[4.5rem] shrink-0 text-xs text-muted-foreground tabular-nums"
              title={String(row.createdAt)}
            >
              {fmtTimestamp(row.createdAt)}
            </span>
            <span class="shrink-0 font-mono text-xs font-semibold text-foreground">
              {row.verb}
            </span>
            {#if fmtParams(row.paramsSummary)}
              <span
                class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
                title={fmtParams(row.paramsSummary)}
              >
                {fmtParams(row.paramsSummary)}
              </span>
            {/if}
            <Badge
              variant="outline"
              class="text-xs uppercase tracking-wide {resultBadgeClass(row.result)}"
            >
              {row.result}
            </Badge>
            {#if row.error}
              <span class="w-full truncate font-mono text-xs italic text-destructive">
                {row.error}
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    </Card.Root>
  {/if}
</div>
