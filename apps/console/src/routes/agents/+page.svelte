<script lang="ts">
  import { WarnBox } from "$lib/components/ui/warn-box";
  import { onMount } from "svelte";
  import { startPolling } from "$lib/utils/poll";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { getFleet, listStations } from "$lib/api/client";
  import { listPrincipals, type PrincipalSummary } from "$lib/api/grants";
  import { unassignStationAgent } from "$lib/api/agents";
  import type { FleetAgent } from "@agentpod/contract";
  import PageHeader from "$lib/components/page-header.svelte";
  import AgentTable from "$lib/components/fleet/AgentTable.svelte";
  import AgentCreate, { type StationOption } from "$lib/components/fleet/AgentCreate.svelte";
  import AssignAgent, { type AssignStationTarget, type AssignCandidate } from "$lib/components/fleet/AssignAgent.svelte";
  import StatusRibbon from "$lib/components/fleet/StatusRibbon.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { toast } from "svelte-sonner";
  import UserPlusIcon from "@lucide/svelte/icons/user-plus";
  import UserXIcon from "@lucide/svelte/icons/user-x";
  import UserCheckIcon from "@lucide/svelte/icons/user-check";
  import BanIcon from "@lucide/svelte/icons/ban";
  import { auth } from "$lib/stores/auth.svelte";
  import { workspaceAdminsCan } from "$lib/workspace-authority";

  /** Creating, assigning and unassigning agents are a workspace admin's. */
  const wsAdmin = $derived(auth.isWorkspaceAdmin);

  interface ExternalFilter {
    stationId?: string;
    status?: string;
    updatesOnly?: boolean;
  }

  let agents = $state<FleetAgent[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  /**
   * stationId → occupying principal id, or null. Built from `listStations`
   * (the DB row already carries `principalId`; `getFleet`'s aggregate
   * doesn't) — this is the first half of turning "healthy" into "healthy AND
   * dispatchable" or "healthy but nobody can dispatch it".
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

  /**
   * The second half: a station can carry a principal id and still be
   * dispatchable by nobody, because that principal is suspended. Only
   * `principalId !== null` was checked before this — which reads a
   * suspended agent's station as "assigned", i.e. healthy, which is exactly
   * the invisibility this task exists to remove, just arriving through a
   * different door. `GET /api/admin/principals` already carries `suspendedAt`.
   */
  let principalsById = $state<Map<string, PrincipalSummary>>(new Map());
  let principalsError = $state<string | null>(null);

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

  type StationStatus =
    | { id: string; stationKey: string; displayName: string; nodeName: string; kind: "unassigned" }
    | {
        id: string;
        stationKey: string;
        displayName: string;
        nodeName: string;
        kind: "suspended";
        principal: PrincipalSummary;
      }
    | {
        id: string;
        stationKey: string;
        displayName: string;
        nodeName: string;
        kind: "active";
        principal: PrincipalSummary;
      };

  /**
   * Every adopted station this page knows about, classified by whether it
   * can actually be dispatched right now — not merely whether a principal id
   * is on the row. Omits stations `assignments` hasn't resolved yet (still
   * loading, or the lookup failed) rather than guessing either way.
   */
  let stationStatuses = $derived.by((): StationStatus[] =>
    agents.flatMap((a): StationStatus[] => {
      const info = assignments.get(a.stationId);
      if (!info) return [];
      const base = { id: a.stationId, stationKey: info.stationKey, displayName: a.agentName, nodeName: a.nodeName };
      if (info.principalId === null) {
        return [{ ...base, kind: "unassigned" }];
      }
      const principal = principalsById.get(info.principalId);
      // A principal id on the row that the directory doesn't (yet) know is
      // treated as active rather than flagged — the directory can lag the
      // assignment on first load, and there is no path today for a
      // principal to be deleted out from under a station.
      if (!principal || !principal.suspendedAt) {
        return [{ ...base, kind: "active", principal: principal ?? { id: info.principalId, kind: "agent", handle: info.principalId, displayName: null, userId: null, suspendedAt: null } }];
      }
      return [{ ...base, kind: "suspended", principal }];
    })
  );

  let unassignedStations = $derived(
    stationStatuses.filter((s): s is Extract<StationStatus, { kind: "unassigned" }> => s.kind === "unassigned")
  );
  let suspendedStations = $derived(
    stationStatuses.filter((s): s is Extract<StationStatus, { kind: "suspended" }> => s.kind === "suspended")
  );
  let activeStations = $derived(
    stationStatuses.filter((s): s is Extract<StationStatus, { kind: "active" }> => s.kind === "active")
  );
  /** Stations that cannot be dispatched right now, for any reason. */
  let blockedStations = $derived([...unassignedStations, ...suspendedStations]);

  let unassignedOptions = $derived<StationOption[]>(
    unassignedStations.map((s) => ({ id: s.id, stationKey: s.stationKey, displayName: s.displayName, nodeName: s.nodeName }))
  );

  /**
   * stationId → occupied station's own {id, displayName} — from
   * `stationStatuses`, which already carries a human-readable name per
   * station (`assignments` alone only has `stationKey`). Occupancy is
   * exclusive as of the fix round on Task 5 (`stations_principal_id_idx`,
   * `routes/agents-admin.ts`'s assign-is-a-move), so a principal occupies at
   * most one station and this map is unambiguous by construction.
   */
  let occupiedStationByPrincipal = $derived.by((): Map<string, { id: string; displayName: string }> => {
    const map = new Map<string, { id: string; displayName: string }>();
    for (const s of stationStatuses) {
      if (s.kind === "active" || s.kind === "suspended") {
        map.set(s.principal.id, { id: s.id, displayName: s.displayName });
      }
    }
    return map;
  });

  /**
   * Every agent principal, occupied or not — the pool Ruling 6's "assign an
   * existing agent" control offers. Picking an already-occupied one is now
   * safe rather than orphaning: `routes/agents-admin.ts`'s assign endpoint
   * vacates a principal's previous station in the same transaction it
   * places it in a new one. Each candidate carries where it currently runs,
   * if anywhere, so the control can label a move as a move — not filtered
   * down to unoccupied ones, which would hide the exact capability this
   * ruling exists to add.
   */
  let assignCandidates = $derived.by((): AssignCandidate[] =>
    [...principalsById.values()]
      .filter((p) => p.kind === "agent")
      .map((p) => ({ principal: p, currentStation: occupiedStationByPrincipal.get(p.id) ?? null }))
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

  async function loadPrincipals() {
    // The directory is a workspace admin's; a member asking would 403 on every poll.
    if (!wsAdmin) return;
    try {
      principalsById = new Map((await listPrincipals()).map((p) => [p.id, p]));
      principalsError = null;
    } catch (e) {
      principalsError =
        e instanceof Error ? e.message : "Couldn't check which agents are suspended.";
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
      await Promise.all([
        loadAssignments([...new Set(result.agents.map((a) => a.nodeId))]),
        loadPrincipals(),
      ]);
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

  // `?action=create` (the palette's "Create an agent") opens the dialog, also when /agents is
  // already mounted. The same guard as NodesOverview's: a handled value is not handled again
  // (a back-navigation can restore the stale query), and it resets once the URL has no action.
  let handledAction = $state<string | null>(null);
  $effect(() => {
    const action = (page.url as { searchParams?: URLSearchParams } | undefined)?.searchParams?.get("action") ?? null;
    if (!action) {
      handledAction = null;
      return;
    }
    if (action === handledAction) return;
    handledAction = action;
    if (action === "create" && wsAdmin) openCreateGeneric();
    try {
      replaceState("/agents", {});
    } catch {
      // non-critical where history is unavailable
    }
  });

  function handleAgentCreated() {
    void loadFleet();
  }

  // ── Assign an existing agent — Ruling 6: the way back for a stranded one ──
  //
  // AgentCreate wires `assignStationAgent`'s only caller before this: minting
  // a brand-new principal and handing it a station in one click. An operator
  // who unassigns one (below) had no way to put it — or any other existing
  // principal — into a station again, short of SQL.

  let assignOpen = $state(false);
  let assignTarget = $state<AssignStationTarget | null>(null);

  function openAssign(station: AssignStationTarget) {
    assignTarget = station;
    assignOpen = true;
  }

  function handleAgentAssigned() {
    void loadFleet();
  }

  // ── Unassign — the other half of the pair, and a real control ────────────
  //
  // Task 2 built DELETE .../agent; until this, nothing in the console ever
  // called it, so a mis-assignment (or a since-suspended agent left sitting
  // in a station) could only be undone with SQL — the exact thing this
  // slice exists to end.

  let showUnassign = $state(false);
  let unassignTarget = $state<Extract<StationStatus, { kind: "suspended" | "active" }> | null>(null);
  let isUnassigning = $state(false);

  function openUnassign(station: Extract<StationStatus, { kind: "suspended" | "active" }>) {
    unassignTarget = station;
    showUnassign = true;
  }

  async function handleUnassign() {
    if (!unassignTarget) return;
    isUnassigning = true;
    try {
      await unassignStationAgent(unassignTarget.id);
      toast.success(`${unassignTarget.displayName} unassigned`);
      showUnassign = false;
      unassignTarget = null;
      await loadFleet();
    } catch (e) {
      toast.error("Couldn't unassign", {
        description: e instanceof Error ? e.message : "Something went wrong.",
      });
    } finally {
      isUnassigning = false;
    }
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
    {#if wsAdmin}
      <Button variant="outline" onclick={openCreateGeneric}>
        <UserPlusIcon class="h-4 w-4" />
        Create agent
      </Button>
    {/if}
  {/snippet}
</PageHeader>

<div class="ap-page">
  {#if isLoading}
    <div class="space-y-3">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-10 rounded-lg" />
      {/each}
    </div>

  {:else if error}
    <div class="ap-alert" role="alert">
      <p class="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onclick={() => loadFleet()}>Retry</Button>
    </div>

  {:else}
    {#if !wsAdmin}
      <p class="ap-card text-sm text-muted-foreground" data-testid="agents-member">
        {workspaceAdminsCan("create agents and assign them to stations")}
      </p>
    {:else if assignmentsError || principalsError}
      <WarnBox
        class="flex items-start justify-between gap-3"
        role="alert"
      >
        <p class="text-xs text-warn-text">{assignmentsError ?? principalsError}</p>
        <Button
          variant="outline"
          size="sm"
          onclick={() => {
            void loadAssignments(assignedNodeIds);
            void loadPrincipals();
          }}
        >
          Retry
        </Button>
      </WarnBox>
    {:else if agents.length > 0}
      {#if blockedStations.length > 0}
        <!-- The point of this task: a station that cannot be dispatched must
             read that way, not merely healthy — whether because nobody has
             assigned it an agent, or because the agent it has is suspended.
             Either way a fleet-wide refusal to dispatch otherwise produces no
             signal anywhere in this console. -->
        <WarnBox data-testid="unassigned-stations">
          <div class="flex items-start gap-2">
            <UserXIcon class="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
            <div class="space-y-1">
              <p class="text-sm font-medium">
                {blockedStations.length}
                {blockedStations.length === 1 ? "station can't" : "stations can't"} be dispatched
              </p>
              <p class="text-xs text-muted-foreground">
                A station with no agent, or whose agent is suspended, is dispatchable by nobody —
                correct behaviour for a station nobody has assigned yet, but indistinguishable
                from a fault unless it's shown here.
              </p>
            </div>
          </div>
          <ul class="mt-3 space-y-2">
            {#each unassignedStations as station (station.id)}
              <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border bg-background px-3 py-2">
                <div class="min-w-[min(14rem,100%)] flex-1">
                  <p class="truncate text-sm font-medium">{station.displayName}</p>
                  <p class="text-xs text-muted-foreground">{station.nodeName} · no agent</p>
                </div>
                <div class="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Assign an existing agent to {station.displayName}"
                    onclick={() =>
                      openAssign({ id: station.id, displayName: station.displayName, nodeName: station.nodeName })}
                  >
                    Assign an existing agent
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={() =>
                      openCreateForStation({
                        id: station.id,
                        stationKey: station.stationKey,
                        displayName: station.displayName,
                        nodeName: station.nodeName,
                      })}
                  >
                    Create an agent for this station
                  </Button>
                </div>
              </li>
            {/each}
            {#each suspendedStations as station (station.id)}
              <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border bg-background px-3 py-2">
                <div class="min-w-[min(14rem,100%)] flex-1">
                  <p class="truncate text-sm font-medium">{station.displayName}</p>
                  <p class="flex items-center gap-1 text-xs text-destructive">
                    <BanIcon class="h-3 w-3 shrink-0" aria-hidden="true" />
                    {station.nodeName} · agent suspended — {station.principal.handle}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    Suspended principals are refused everywhere. Unassign to free the station, or
                    <a href="/admin/grants" class="underline hover:text-foreground">restore it in Grants</a>.
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Assign a different agent to {station.displayName}"
                    onclick={() => openAssign({ id: station.id, displayName: station.displayName, nodeName: station.nodeName })}
                  >
                    Assign a different agent
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    aria-label="Unassign {station.displayName}"
                    onclick={() => openUnassign(station)}
                  >
                    Unassign
                  </Button>
                </div>
              </li>
            {/each}
          </ul>
        </WarnBox>
      {:else}
        <p class="ap-card ap-ok flex items-center gap-2 font-semibold" data-testid="all-assigned">
          <UserCheckIcon class="h-4 w-4 text-status-running" aria-hidden="true" />
          Every adopted station has an active agent assigned.
        </p>
      {/if}

      {#if activeStations.length > 0}
        <!-- The other half of "wire unassign to a real control": even a
             correctly-assigned station needs a way off, or a mis-assignment
             can only be undone with SQL. -->
        <section class="ap-card" data-testid="assigned-stations" aria-labelledby="assigned-stations-h">
          <h2 id="assigned-stations-h" class="ap-h2 mb-3">
            {activeStations.length} {activeStations.length === 1 ? "station is" : "stations are"} assigned
          </h2>
          <ul class="ap-asg">
            {#each activeStations as station (station.id)}
              <!-- The name column is a fixed width from sm up, so the actions sit
                   beside the name they act on — at 1920 they were ~1000px
                   away. On a phone the actions wrap under the name rather
                   than squeezing it to its first letter. -->
              <li class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div class="flex min-w-[min(12rem,100%)] flex-1 items-center gap-2">
                  <span class="ap-asg__name truncate">{station.displayName}</span>
                  <Badge variant="outline" class="ap-asg__handle shrink-0 font-mono">{station.principal.handle}</Badge>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    class="ap-asg__act"
                    aria-label="Assign a different agent to {station.displayName}"
                    onclick={() => openAssign({ id: station.id, displayName: station.displayName, nodeName: station.nodeName })}
                  >
                    Assign a different agent
                  </Button>
                  <Button
                    variant="ghost"
                    class="ap-asg__act ap-asg__act--danger"
                    aria-label="Unassign {station.displayName}"
                    onclick={() => openUnassign(station)}
                  >
                    Unassign
                  </Button>
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {/if}

    <section class="ap-card ap-card--cards" aria-label="Agent table">
      <AgentTable {agents} {externalFilter} />
    </section>
  {/if}
</div>

<AgentCreate
  bind:open={createOpen}
  station={createForStation}
  stationOptions={createForStation ? [] : unassignedOptions}
  onCreated={handleAgentCreated}
/>

<AssignAgent
  bind:open={assignOpen}
  station={assignTarget}
  candidates={assignCandidates}
  onAssigned={handleAgentAssigned}
/>

<ConfirmDialog
  open={showUnassign}
  title="Unassign agent"
  message={unassignTarget
    ? `${unassignTarget.displayName}'s agent (${unassignTarget.principal.handle}) will be removed from this station. It becomes dispatchable by nobody until an agent is assigned again.`
    : ""}
  confirmLabel="Unassign"
  destructive
  onConfirm={handleUnassign}
  onCancel={() => {
    if (isUnassigning) return;
    showUnassign = false;
    unassignTarget = null;
  }}
/>
