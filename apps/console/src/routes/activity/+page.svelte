<script lang="ts">
  import { onMount } from "svelte";
  import { listActivity } from "$lib/api/client";
  import type { ActivityRow } from "$lib/api/client";
  import type { ColumnDef } from "@tanstack/table-core";
  import PageHeader from "$lib/components/page-header.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Button } from "$lib/components/ui/button";
  import { Empty } from "$lib/components/ui/empty";
  import { DataTable, renderSnippet } from "$lib/components/ui/data-table";
  import { relativeTime } from "$lib/utils/relative-time";
  import { statusTextClass } from "$lib/utils/status-badge";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import SearchIcon from "@lucide/svelte/icons/search";

  let rows = $state<ActivityRow[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let filterValue = $state("");

  /** Text color for a result value (ok → running token, error → error token, else muted). */
  function resultClass(result: string | undefined): string {
    if (!result) return "text-muted-foreground/50";
    switch (result.toLowerCase()) {
      case "ok":
        return statusTextClass("running");
      case "error":
        return statusTextClass("error");
      default:
        return "text-muted-foreground";
    }
  }

  async function load() {
    isLoading = true;
    error = null;
    try {
      rows = await listActivity();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load activity";
    } finally {
      isLoading = false;
    }
  }

  onMount(load);

  // Cell snippets (verbCell, nodeCell, resultCell, whenCell) are declared in
  // the markup below; referencing them here is safe because these arrow
  // functions only run later, when FlexRender invokes them — by then the
  // snippet bindings are already initialized.
  const columns: ColumnDef<ActivityRow>[] = [
    {
      accessorKey: "verb",
      header: "Verb",
      cell: (ctx) => renderSnippet(verbCell, { value: ctx.getValue<string>() }),
    },
    {
      id: "station",
      header: "Station",
      accessorFn: (row) => row.stationKey ?? "—",
    },
    {
      id: "node",
      header: "Node",
      accessorFn: (row) => row.nodeId ?? "",
      cell: (ctx) => renderSnippet(nodeCell, { value: ctx.getValue<string>() }),
    },
    {
      accessorKey: "result",
      header: "Result",
      cell: (ctx) => renderSnippet(resultCell, { value: ctx.getValue<string | undefined>() }),
    },
    {
      accessorKey: "createdAt",
      header: "When",
      cell: (ctx) => renderSnippet(whenCell, { value: ctx.getValue<string>() }),
    },
  ];
</script>

{#snippet verbCell({ value }: { value: string })}
  <span class="font-mono text-xs font-medium">{value}</span>
{/snippet}

{#snippet nodeCell({ value }: { value: string })}
  <span class="block max-w-[10rem] truncate font-mono text-xs text-muted-foreground" title={value || undefined}>
    {value ? value.slice(0, 8) : "—"}
  </span>
{/snippet}

{#snippet resultCell({ value }: { value: string | undefined })}
  <span class={resultClass(value)}>{value ?? "—"}</span>
{/snippet}

{#snippet whenCell({ value }: { value: string })}
  <span class="font-mono text-xs text-muted-foreground whitespace-nowrap">{relativeTime(value)}</span>
{/snippet}

<PageHeader title="Activity" subtitle="// fleet event log" />

<div class="container mx-auto px-4 sm:px-6 max-w-7xl py-6 space-y-3">
  {#if isLoading}
    <div class="space-y-2">
      {#each [1, 2, 3, 4, 5] as _}
        <Skeleton class="h-9 rounded-sm" />
      {/each}
    </div>

  {:else if error}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <p class="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onclick={load}>Retry</Button>
    </div>

  {:else if rows.length === 0}
    <div data-testid="empty-state">
      <Empty title="No activity yet" description="Activity from the fleet will appear here." icon={ActivityIcon} />
    </div>

  {:else}
    <div class="relative max-w-sm">
      <SearchIcon
        class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        type="search"
        placeholder="Search activity…"
        bind:value={filterValue}
        class="h-8 w-full rounded-md border bg-transparent py-1.5 pl-7 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Search activity"
      />
    </div>

    <DataTable {columns} data={rows} pageSize={50} bind:filterValue rowTestId="activity-row" />
  {/if}
</div>
