<script lang="ts">
  import { onMount } from "svelte";
  import { startPolling } from "$lib/utils/poll";
  import { page } from "$app/state";
  import { getFleet, listStations } from "$lib/api/client";
  import type { FleetAgent } from "@agentpod/contract";
  import PageHeader from "$lib/components/page-header.svelte";
  import AgentTable from "$lib/components/fleet/AgentTable.svelte";
  import AgentCreate, { type StationOption } from "$lib/components/fleet/AgentCreate.svelte";
  import StatusRibbon from "$lib/components/fleet/StatusRibbon.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Button } from "$lib/components/ui/button";
  import UserPlusIcon from "@lucide/svelte/icons/user-plus";
  import UserXIcon from "@lucide/svelte/icons/user-x";
  import UserCheckIcon from "@lucide/svelte/icons/user-check";

  interface ExternalFilter {
    stationId?: string;
    status?: string;
    updatesOnly?: boolean;
  }

  let agents = $state<FleetAgent[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  /**
   * stationId → occupying principal, or null. Built from `listStations` (the
   * DB row already carries `principalId`; `getFleet`'s aggregate doesn't) —
   * this is what turns "healthy" into "healthy AND dispatchable" or
   * "healthy but nobody can dispatch it".
   *
   * A station with no principal is *correct*, deliberate behaviour
   * (`charter → decisions/2026-08-30-an-agent-is-a-principal.md`), not a
   * fault — and until this page existed it had no signal at all: the fleet
   * table shows process health, which is unrelated to whether anything may
   * dispatch the station.
   */
  let assignments = $state<Map<string, { stationKey: string; principalId: string | null }>>(new Map());
  let assignmentsError = $state<string | null>(null);
  let assignedNodeIds: string[] = [];

  // Derive the external filter from the URL query params reactively.
  // ?station=<id> → filter by stationId; ?status=<s> → filter by status
  // (station wins when both are present); ?updates=1 → updatesOnly, which
  // composes with either — AgentTable applies every present filter together.
  let externalFilter = $derived.by((): ExternalFilter | null => {
    const params = (page.url as { searchParams?: URLSearchParams | null }).searchParams;
    if (!params) return null;
    const station = params.get("station");
    const status = params.get("status");
    const updatesOnly = params.get("updates") === "1";
    if (!station && !status && !updatesOnly) return null;
    const filter: ExternalFilter = {};
    if (station) filter.stationId = station;
    else if (status) filter.status = status;
    if (updatesOnly) filter.updatesOnly = true;
    return filter;
  });

  /** Every adopted station this fleet page knows about that has no occupying agent. */
  let unassignedStations = $derived.by((): StationOption[] =>
    agents
      .filter((a) => assignments.get(a.stationId)?.principalId === null)
      .map((a) => ({
        id: a.stationId,
        stationKey: assignments.get(a.stationId)!.stationKey,
        displayName: a.agentName,
        nodeName: a.nodeName,
      }))
  );

  async function loadAssignments(nodeIds: string[]) {
    assignedNodeIds = nodeIds;
    try {
      const rows = await Promise.all(nodeIds.map((id) => listStations(id)));
      const map = new Map<string, { stationKey: string; principalId: string | null }>();
      for (const stations of rows) {
        for (const s of stations) map.set(s.id, { stationKey: s.stationKey, principalId: s.principalId });
      }
      assignments = map;
      assignmentsError = null;
    } catch (e) {
      // Non-fatal to the page — the fleet table itself still renders. Losing
      // this specific check must say so rather than silently claiming every
      // station has an agent.
      assignmentsError =
        e instanceof Error ? e.message : "Couldn't check which stations have an agent.";
    }
  }

  async function loadFleet(background = false) {
    if (!background) {
      isLoading = true;
      error = null;
    }
    try {
      const result = await getFleet();
      agents = result.agents;
      error = null;
      await loadAssignments([...new Set(result.agents.map((a) => a.nodeId))]);
    } catch (e) {
      // Background refreshes keep the last good data on screen; the shell's
      // hub-unreachable banner carries the staleness signal.
      if (!background) error = e instanceof Error ? e.message : "Couldn't load the fleet.";
    } finally {
      if (!background) isLoading = false;
    }
  }

  onMount(() => {
    void loadFleet();
    return startPolling(() => void loadFleet(true), 30_000);
  });

  // ── Create-and-assign dialog ──────────────────────────────────────────────

  let createOpen = $state(false);
  /** Set when opened from a specific station's "Create an agent for this
   *  station" action — the target is fixed rather than picked. */
  let createForStation = $state<StationOption | null>(null);

  function openCreateForStation(station: StationOption) {
    createForStation = station;
    createOpen = true;
  }

  function openCreateGeneric() {
    createForStation = null;
    createOpen = true;
  }

  function handleAgentCreated() {
    void loadFleet();
  }
</script>

<svelte:head>
  <title>Agents · AgentPod</title>
</svelte:head>

<PageHeader title="Agents" subtitle="Every agent in the fleet">
  {#snippet ribbon()}
    {#if agents.length > 0}
      <StatusRibbon
        size="xs"
        items={agents.map((a) => ({ id: a.stationId, label: a.agentName, status: a.status }))}
      />
    {/if}
  {/snippet}
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={openCreateGeneric}>
      <UserPlusIcon class="mr-1 h-3.5 w-3.5" />
      Create agent
    </Button>
  {/snippet}
</PageHeader>

<div class="container mx-auto px-4 sm:px-6 max-w-7xl py-6 space-y-4">
  {#if isLoading}
    <div class="space-y-3">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-10 rounded-lg" />
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

  {:else}
    {#if assignmentsError}
      <div
        class="flex items-start justify-between gap-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3"
        role="alert"
      >
        <p class="text-xs text-amber-700 dark:text-amber-400">{assignmentsError}</p>
        <Button variant="outline" size="sm" onclick={() => loadAssignments(assignedNodeIds)}>Retry</Button>
      </div>
    {:else if agents.length > 0}
      {#if unassignedStations.length > 0}
        <!-- The point of this task: a station with no occupying agent must read
             as unassigned, not merely healthy — a fleet-wide refusal to
             dispatch otherwise produces no signal anywhere in this console. -->
        <div class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4" data-testid="unassigned-stations">
          <div class="flex items-start gap-2">
            <UserXIcon class="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <div class="space-y-1">
              <p class="text-sm font-medium">
                {unassignedStations.length}
                {unassignedStations.length === 1 ? "station has" : "stations have"} no agent
              </p>
              <p class="text-xs text-muted-foreground">
                A station with no occupying agent is dispatchable by nobody — correct behaviour
                for a station nobody has assigned yet, but indistinguishable from a fault unless
                it's shown. Give one a principal to make it dispatchable.
              </p>
            </div>
          </div>
          <ul class="mt-3 space-y-2">
            {#each unassignedStations as station (station.id)}
              <li class="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{station.displayName}</p>
                  <p class="text-xs text-muted-foreground">{station.nodeName} · no agent</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  class="shrink-0"
                  onclick={() => openCreateForStation(station)}
                >
                  Create an agent for this station
                </Button>
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <p class="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="all-assigned">
          <UserCheckIcon class="h-3.5 w-3.5" aria-hidden="true" />
          Every adopted station has an agent assigned.
        </p>
      {/if}
    {/if}

    <AgentTable {agents} {externalFilter} />
  {/if}
</div>

<AgentCreate
  bind:open={createOpen}
  station={createForStation}
  stationOptions={createForStation ? [] : unassignedStations}
  onCreated={handleAgentCreated}
/>
