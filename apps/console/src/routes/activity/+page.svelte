<script lang="ts">
  /**
   * /activity — the fleet's audit log in full.
   *
   * Same rows, same collapsing and same reading order as the muster's feed,
   * because they are literally the same component. What this page adds is the
   * search box: the muster shows the last few things that happened, this one
   * is where you go looking for a particular one.
   */
  import { onMount } from "svelte";
  import { listActivity } from "$lib/api/client";
  import type { ActivityRow } from "$lib/api/client";
  import PageHeader from "$lib/components/page-header.svelte";
  import ActivityFeed from "$lib/components/fleet/ActivityFeed.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Button } from "$lib/components/ui/button";
  import { Empty } from "$lib/components/ui/empty";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import SearchIcon from "@lucide/svelte/icons/search";

  let rows = $state<ActivityRow[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let query = $state("");

  async function load() {
    isLoading = true;
    error = null;
    try {
      rows = await listActivity();
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn’t load activity.";
    } finally {
      isLoading = false;
    }
  }

  onMount(load);

  /**
   * Filtering happens BEFORE the feed collapses, so a search that excludes
   * the middle of a run lets its two halves merge — which is right: what the
   * reader is looking at is then genuinely one uninterrupted run of matches.
   */
  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return rows;
    return rows.filter((row) =>
      [row.verb, row.stationKey ?? "", row.nodeId ?? "", row.result ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  });
</script>

<svelte:head>
  <title>Activity · AgentPod</title>
</svelte:head>

<PageHeader title="Activity" subtitle="Fleet event log" />

<div class="container mx-auto max-w-5xl space-y-3 px-4 py-6 sm:px-6">
  {#if isLoading}
    <div class="space-y-2">
      {#each [1, 2, 3, 4, 5] as _}
        <Skeleton class="h-9 rounded-sm" />
      {/each}
    </div>

  {:else if error}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-status-error/50 bg-status-error/5 p-4"
      role="alert"
    >
      <p class="text-sm text-status-error">{error}</p>
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
        bind:value={query}
        class="h-8 w-full rounded-md border bg-transparent py-1.5 pl-7 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
        aria-label="Search activity"
      />
    </div>

    <ActivityFeed rows={visible} />
  {/if}
</div>
