<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { getFleet } from "$lib/api/client";
  import type { FleetAgent } from "@agentpod/contract";
  import PageHeader from "$lib/components/page-header.svelte";
  import AgentTable from "$lib/components/fleet/AgentTable.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Button } from "$lib/components/ui/button";

  interface ExternalFilter {
    stationId?: string;
    status?: string;
  }

  let agents = $state<FleetAgent[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  // Derive the external filter from the URL query params reactively.
  // ?station=<id> → filter by stationId; ?status=<s> → filter by status.
  let externalFilter = $derived.by((): ExternalFilter | null => {
    const params = (page.url as { searchParams?: URLSearchParams | null }).searchParams;
    if (!params) return null;
    const station = params.get("station");
    if (station) return { stationId: station };
    const status = params.get("status");
    if (status) return { status };
    return null;
  });

  async function loadFleet() {
    isLoading = true;
    error = null;
    try {
      const result = await getFleet();
      agents = result.agents;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load fleet";
    } finally {
      isLoading = false;
    }
  }

  onMount(async () => {
    await loadFleet();
  });
</script>

<PageHeader title="Agents" subtitle="Every agent in the fleet" />

<div class="container mx-auto px-4 sm:px-6 max-w-7xl py-6">
  {#if isLoading}
    <div class="space-y-3">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-10 rounded-sm" />
      {/each}
    </div>

  {:else if error}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <p class="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onclick={loadFleet}>Retry</Button>
    </div>

  {:else}
    <AgentTable {agents} {externalFilter} />
  {/if}
</div>
