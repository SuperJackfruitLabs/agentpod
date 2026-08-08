<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { getFleet, createEnrollmentToken } from "$lib/api/client";
  import { startPolling } from "$lib/utils/poll";
  import type { FleetStats, FleetAgent } from "@agentpod/contract";
  import PageHeader from "$lib/components/page-header.svelte";
  import OverviewStats from "$lib/components/fleet/OverviewStats.svelte";
  import FleetHeatmap from "$lib/components/fleet/FleetHeatmap.svelte";
  import StatusRibbon from "$lib/components/fleet/StatusRibbon.svelte";
  import NeedsAttention from "$lib/components/fleet/NeedsAttention.svelte";
  import RecentActivity from "$lib/components/fleet/RecentActivity.svelte";
  import ConnectBanner from "$lib/components/fleet/connect-banner.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Button } from "$lib/components/ui/button";

  let stats = $state<FleetStats | null>(null);
  let agents = $state<FleetAgent[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  // Enrollment token state (for empty-state connect banner)
  let lastToken = $state<string | null>(null);
  let isMinting = $state(false);

  // ── Heatmap navigation callbacks ──────────────────────────────────────────────

  function handleSelectAgent(stationId: string) {
    goto("/agents?station=" + stationId);
  }

  function handleFilterStatus(status: string) {
    goto("/agents?status=" + status);
  }

  async function loadFleet(background = false) {
    if (!background) {
      isLoading = true;
      error = null;
    }
    try {
      const result = await getFleet();
      stats = result.stats;
      agents = result.agents;
      error = null;
    } catch (e) {
      // Background refreshes keep the last good data on screen — the shell's
      // hub-unreachable banner carries the staleness signal instead.
      if (!background) error = e instanceof Error ? e.message : "Couldn't load the fleet.";
    } finally {
      if (!background) isLoading = false;
    }
  }

  async function handleCreateToken() {
    isMinting = true;
    try {
      const result = await createEnrollmentToken();
      lastToken = result.token;
    } catch {
      // non-fatal in empty state — ConnectBanner handles the error display
    } finally {
      isMinting = false;
    }
  }

  onMount(() => {
    void loadFleet();
    return startPolling(() => void loadFleet(true), 30_000);
  });
</script>

<svelte:head>
  <title>Overview · AgentPod</title>
</svelte:head>

<PageHeader title="Overview" subtitle="Fleet control plane">
  {#snippet ribbon()}
    {#if agents.length > 0}
      <StatusRibbon
        size="xs"
        items={agents.map((a) => ({ id: a.stationId, label: a.agentName, status: a.status }))}
      />
    {/if}
  {/snippet}
</PageHeader>

<div class="container mx-auto px-4 sm:px-6 max-w-7xl py-6 space-y-6">
  {#if isLoading}
    <!-- Loading skeleton for stat cards -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-20 rounded-lg" />
      {/each}
    </div>

  {:else if error}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <p class="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onclick={() => loadFleet()}>Retry</Button>
    </div>

  {:else if agents.length === 0}
    <!-- Empty state: no agents enrolled yet -->
    <div class="flex flex-col items-center py-8">
      <div class="w-full max-w-2xl">
        {#if lastToken}
          <div class="rounded-lg border p-6 space-y-3">
            <p class="text-xs text-muted-foreground">Enrollment token created — run this on the target node to connect it</p>
            <code class="block text-sm font-mono break-all text-primary">
              curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh | sudo bash -s -- {lastToken}
            </code>
            <p class="text-xs text-muted-foreground/60">The node will appear in the fleet once it connects</p>
          </div>
        {:else}
          <ConnectBanner onCreateToken={handleCreateToken} />
        {/if}
      </div>
    </div>

  {:else}
    <!-- Stat band -->
    {#if stats}
      <OverviewStats {stats} />
    {/if}

    <!-- Fleet heatmap — clicking a cell navigates to /agents filtered by that station -->
    <div class="rounded-lg border p-4 space-y-2">
      <h2 class="t-section">Fleet health</h2>
      <FleetHeatmap
        {agents}
        onSelectAgent={handleSelectAgent}
        onFilterStatus={handleFilterStatus}
      />
    </div>

    <!-- Dashboard panels: Needs Attention + Recent Activity -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <NeedsAttention {agents} />
      <RecentActivity />
    </div>
  {/if}
</div>
