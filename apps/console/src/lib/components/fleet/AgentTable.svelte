<script lang="ts">
  import { untrack } from "svelte";
  import type { FleetAgent } from "@agentpod/contract";
  import { updateNode } from "$lib/api/client";
  import { statusBadgeClass, tokenFor, type StatusToken } from "$lib/utils/status-badge";
  import { chipClass } from "$lib/utils/toggle-chip";
  import { Badge } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import { Empty } from "$lib/components/ui/empty";
  import { cn } from "$lib/utils";
  import { toast } from "svelte-sonner";
  import SearchIcon from "@lucide/svelte/icons/search";

  // ── External filter (from heatmap) ───────────────────────────────────────────

  interface ExternalFilter {
    stationId?: string;
    status?: string;
    updatesOnly?: boolean;
  }

  let {
    agents,
    externalFilter = null,
  }: {
    agents: FleetAgent[];
    externalFilter?: ExternalFilter | null;
  } = $props();

  // ── Metric formatters ────────────────────────────────────────────────────────

  function formatCpu(cpuPct: number | null): string {
    if (cpuPct === null) return "—";
    return `${cpuPct.toFixed(1)}%`;
  }

  function formatMem(memBytes: number | null): string {
    if (memBytes === null) return "—";
    const mb = memBytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${Math.round(mb)} MB`;
  }

  function formatUptime(uptimeSec: number | null): string {
    if (uptimeSec === null) return "—";
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // ── Toolbar state ────────────────────────────────────────────────────────────

  let searchQuery = $state("");
  let groupByNode = $state(true);
  // Seeded once from the incoming deep-link (?updates=1 → externalFilter.updatesOnly)
  // so the URL wins on first render; the pill stays freely user-toggleable afterwards.
  // untrack: intentionally captures the initial prop value only.
  let filterUpdateAvailable = $state(untrack(() => externalFilter?.updatesOnly ?? false));

  // ── Sorting ───────────────────────────────────────────────────────────────────
  // Tri-state per column: click cycles none → asc → desc → none. Sorting
  // applies to the fully-flattened row set in flat view, and independently
  // within each node group in grouped view — group order itself never
  // changes on sort, only the agents inside each group.

  type SortKey = "agent" | "node" | "status" | "cpu" | "mem" | "uptime";
  type SortDir = "asc" | "desc";

  let sortKey = $state<SortKey | null>(null);
  let sortDir = $state<SortDir | null>(null);

  function toggleSort(key: SortKey) {
    if (sortKey !== key) {
      sortKey = key;
      sortDir = "asc";
    } else if (sortDir === "asc") {
      sortDir = "desc";
    } else {
      sortKey = null;
      sortDir = null;
    }
  }

  function ariaSortFor(key: SortKey): "ascending" | "descending" | undefined {
    if (sortKey !== key) return undefined;
    return sortDir === "asc" ? "ascending" : "descending";
  }

  // Status severity order, low → high. An operator scanning the table wants
  // error/degraded states surfaced first, then in-flight starting/running
  // states, with intentionally-idle sleeping and fully-stopped agents last:
  //   error < degraded < starting < running < sleeping < stopped
  const STATUS_SEVERITY: Record<StatusToken, number> = {
    error: 0,
    degraded: 1,
    starting: 2,
    running: 3,
    sleeping: 4,
    stopped: 5,
  };

  // Null health readings (no live metric yet) always sort to the bottom, in
  // both ascending and descending order — a missing reading isn't smaller or
  // larger than a real one, it's absent, so direction only orders the
  // non-null values.
  function compareNullable(a: number | null, b: number | null, dir: SortDir): number {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return dir === "asc" ? a - b : b - a;
  }

  function compareAgents(a: FleetAgent, b: FleetAgent, key: SortKey, dir: SortDir): number {
    switch (key) {
      case "agent":
        return dir === "asc"
          ? a.agentName.localeCompare(b.agentName)
          : b.agentName.localeCompare(a.agentName);
      case "node":
        return dir === "asc"
          ? a.nodeName.localeCompare(b.nodeName)
          : b.nodeName.localeCompare(a.nodeName);
      case "status": {
        const ra = STATUS_SEVERITY[tokenFor(a.status)];
        const rb = STATUS_SEVERITY[tokenFor(b.status)];
        return dir === "asc" ? ra - rb : rb - ra;
      }
      case "cpu":
        return compareNullable(a.cpuPct, b.cpuPct, dir);
      case "mem":
        return compareNullable(a.memBytes, b.memBytes, dir);
      case "uptime":
        return compareNullable(a.uptimeSec, b.uptimeSec, dir);
    }
  }

  // ── Filtered agents ($derived) ────────────────────────────────────────────────

  let filteredAgents = $derived.by(() => {
    let result = agents;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (a) =>
          a.agentName.toLowerCase().includes(q) ||
          a.nodeName.toLowerCase().includes(q)
      );
    }

    if (filterUpdateAvailable) {
      result = result.filter((a) => a.updateAvailable);
    }

    // External filter from heatmap (stationId takes precedence over status)
    if (externalFilter?.stationId) {
      result = result.filter((a) => a.stationId === externalFilter!.stationId);
    } else if (externalFilter?.status) {
      result = result.filter((a) => a.status === externalFilter!.status);
    }

    return result;
  });

  // Flat, fully-sorted row list — used by the flat (non-grouped) view.
  let sortedFlatAgents = $derived.by(() => {
    if (!sortKey || !sortDir) return filteredAgents;
    const key = sortKey;
    const dir = sortDir;
    return [...filteredAgents].sort((a, b) => compareAgents(a, b, key, dir));
  });

  // ── Grouped agents ($derived) ─────────────────────────────────────────────────

  interface NodeGroup {
    nodeId: string;
    nodeName: string;
    agents: FleetAgent[];
  }

  let groupedAgents = $derived.by((): NodeGroup[] => {
    const groups = new Map<string, NodeGroup>();

    // Group membership + group order are derived from filteredAgents (not the
    // sorted set) so sorting never reshuffles which group appears first.
    for (const agent of filteredAgents) {
      if (!groups.has(agent.nodeId)) {
        groups.set(agent.nodeId, {
          nodeId: agent.nodeId,
          nodeName: agent.nodeName,
          agents: [],
        });
      }
      groups.get(agent.nodeId)!.agents.push(agent);
    }

    const result = Array.from(groups.values());

    if (sortKey && sortDir) {
      const key = sortKey;
      const dir = sortDir;
      for (const group of result) {
        group.agents = [...group.agents].sort((a, b) => compareAgents(a, b, key, dir));
      }
    }

    return result;
  });

  // ── Collapse state (keyed by nodeId) ─────────────────────────────────────────

  let collapsedGroups = $state<Record<string, boolean>>({});

  function toggleGroup(nodeId: string) {
    collapsedGroups[nodeId] = !collapsedGroups[nodeId];
  }

  // Auto-expand the group that contains the externally selected agent
  $effect(() => {
    const sid = externalFilter?.stationId;
    if (!sid) return;
    const agent = agents.find((a) => a.stationId === sid);
    if (agent) {
      collapsedGroups[agent.nodeId] = false;
    }
  });

  // ── Per-node update state (mirrors slice-3 pattern from NodesOverview) ────────

  let updatingNodes = $state<Record<string, boolean>>({});

  async function handleUpdate(e: MouseEvent, nodeId: string) {
    e.stopPropagation();
    updatingNodes[nodeId] = true;
    try {
      const result = await updateNode(nodeId);
      if (result.ok) {
        // Keep "updating…" state — node will blip offline→online on the new version
        // and the next fleet refresh will clear updateAvailable.
      } else {
        delete updatingNodes[nodeId];
        toast.error("Update failed", { description: result.error ?? "Unknown error" });
      }
    } catch (err) {
      delete updatingNodes[nodeId];
      toast.error("Update failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
</script>

<!-- ONE row snippet shared by both the grouped and flat branches below. -->
{#snippet agentRow(agent: FleetAgent)}
  <Table.Row>
    <Table.Cell>
      <a
        href="/nodes/{agent.nodeId}/stations/{agent.stationId}"
        class="text-sm text-foreground hover:text-primary transition-colors"
      >
        {agent.agentName}
      </a>
    </Table.Cell>
    <Table.Cell class="hidden sm:table-cell text-xs text-muted-foreground">
      {agent.harness}
    </Table.Cell>
    <Table.Cell class="hidden md:table-cell text-xs text-muted-foreground">
      {agent.nodeName}
    </Table.Cell>
    <Table.Cell>
      <Badge variant="outline" class={statusBadgeClass(agent.status)}>
        {agent.status}
      </Badge>
    </Table.Cell>
    <Table.Cell class="hidden lg:table-cell text-xs text-muted-foreground" data-testid="cpu-cell">
      {formatCpu(agent.cpuPct)}
    </Table.Cell>
    <Table.Cell class="hidden lg:table-cell text-xs text-muted-foreground" data-testid="mem-cell">
      {formatMem(agent.memBytes)}
    </Table.Cell>
    <Table.Cell class="hidden lg:table-cell text-xs text-muted-foreground" data-testid="uptime-cell">
      {formatUptime(agent.uptimeSec)}
    </Table.Cell>
    <Table.Cell class="hidden sm:table-cell text-xs text-muted-foreground">
      {agent.agentVersion ?? "—"}
    </Table.Cell>
    <Table.Cell>
      {#if agent.updateAvailable}
        <button
          type="button"
          disabled={!!updatingNodes[agent.nodeId]}
          onclick={(e) => handleUpdate(e, agent.nodeId)}
          class="text-xs px-2 py-0.5 rounded-md border transition-colors border-primary/50 text-primary hover:border-primary hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {updatingNodes[agent.nodeId] ? "Updating…" : "Update"}
        </button>
      {/if}
    </Table.Cell>
  </Table.Row>
{/snippet}

<!-- Sortable header cell: real <button> inside the <th>, aria-sort on the <th>. -->
{#snippet sortHead(key: SortKey, label: string, extraClass = "")}
  <Table.Head class={cn("text-xs font-medium text-muted-foreground", extraClass)} aria-sort={ariaSortFor(key)}>
    <button
      type="button"
      class="flex items-center gap-1 bg-transparent p-0 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      onclick={() => toggleSort(key)}
    >
      {label}
      {#if sortKey === key}
        <span aria-hidden="true">{sortDir === "asc" ? "↑" : "↓"}</span>
      {/if}
    </button>
  </Table.Head>
{/snippet}

<div class="space-y-3">
  <!-- Toolbar: search + filter pills + group toggle -->
  <div class="flex items-center gap-2 flex-wrap">
    <div class="relative min-w-[180px] flex-1">
      <SearchIcon
        class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        type="search"
        placeholder="Search agents…"
        bind:value={searchQuery}
        class="h-8 w-full rounded-md border bg-transparent py-1.5 pl-7 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Search agents"
      />
    </div>

    <!-- Filter pill: updates only -->
    <button
      type="button"
      onclick={() => (filterUpdateAvailable = !filterUpdateAvailable)}
      class={cn(chipClass(filterUpdateAvailable), "px-2.5 py-1.5 text-xs")}
      aria-pressed={filterUpdateAvailable}
    >
      Updates only
    </button>

    <!-- Group toggle -->
    <button
      type="button"
      data-testid="group-toggle"
      onclick={() => (groupByNode = !groupByNode)}
      class={cn(chipClass(groupByNode), "px-2.5 py-1.5 text-xs")}
      aria-pressed={groupByNode}
    >
      {groupByNode ? "Grouped" : "Flat"}
    </button>
  </div>

  <!-- Dense table -->
  <div class="rounded-lg border overflow-hidden">
    <Table.Root>
      <Table.Header>
        <Table.Row>
          {@render sortHead("agent", "Agent")}
          <Table.Head class="hidden sm:table-cell text-xs font-medium text-muted-foreground">Harness</Table.Head>
          {@render sortHead("node", "Node", "hidden md:table-cell")}
          {@render sortHead("status", "Status")}
          {@render sortHead("cpu", "CPU", "hidden lg:table-cell")}
          {@render sortHead("mem", "Mem", "hidden lg:table-cell")}
          {@render sortHead("uptime", "Uptime", "hidden lg:table-cell")}
          <Table.Head class="hidden sm:table-cell text-xs font-medium text-muted-foreground">Version</Table.Head>
          <Table.Head class="text-xs font-medium text-muted-foreground">Update</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#if filteredAgents.length === 0}
          <Table.Row>
            <Table.Cell colspan={9} class="p-0">
              <Empty title="No agents match the current filter" icon={SearchIcon} class="border-none rounded-none" />
            </Table.Cell>
          </Table.Row>
        {:else if groupByNode}
          {#each groupedAgents as group (group.nodeId)}
            <!-- Group header row -->
            <Table.Row class="bg-muted/20 hover:bg-muted/20">
              <Table.Cell colspan={9} class="py-1.5">
                <button
                  type="button"
                  onclick={() => toggleGroup(group.nodeId)}
                  class="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="group-header"
                >
                  <span class="text-[10px]">{collapsedGroups[group.nodeId] ? "▶" : "▾"}</span>
                  <span class="font-medium text-foreground">{group.nodeName}</span>
                  <span class="text-muted-foreground/60">· {group.agents.length} {group.agents.length === 1 ? "agent" : "agents"}</span>
                </button>
              </Table.Cell>
            </Table.Row>

            {#if !collapsedGroups[group.nodeId]}
              {#each group.agents as agent (agent.stationId)}
                {@render agentRow(agent)}
              {/each}
            {/if}
          {/each}
        {:else}
          <!-- Flat view -->
          {#each sortedFlatAgents as agent (agent.stationId)}
            {@render agentRow(agent)}
          {/each}
        {/if}
      </Table.Body>
    </Table.Root>
  </div>
</div>
