<script lang="ts">
  import type { FleetAgent } from "@agentpod/contract";
  import StatusRibbon, { type RibbonItem } from "./StatusRibbon.svelte";
  import { statusBadgeClass } from "$lib/utils/status-badge";

  let {
    agents,
    onSelectAgent,
    onFilterStatus,
  }: {
    agents: FleetAgent[];
    onSelectAgent: (stationId: string) => void;
    onFilterStatus: (status: string) => void;
  } = $props();

  function cellTitle(agent: FleetAgent): string {
    let title = `${agent.agentName} · ${agent.nodeName} · ${agent.status}`;

    if (agent.kind === "composite") {
      title += " · shared gateway";
    }

    const metrics: string[] = [];
    if (agent.cpuPct !== null) {
      metrics.push(`CPU ${agent.cpuPct.toFixed(1)}%`);
    }
    if (agent.memBytes !== null) {
      const mb = agent.memBytes / (1024 * 1024);
      metrics.push(mb >= 1024 ? `Mem ${(mb / 1024).toFixed(1)} GB` : `Mem ${Math.round(mb)} MB`);
    }
    if (agent.uptimeSec !== null) {
      const h = Math.floor(agent.uptimeSec / 3600);
      const m = Math.floor((agent.uptimeSec % 3600) / 60);
      metrics.push(`Up ${h > 0 ? `${h}h ${m}m` : `${m}m`}`);
    }

    if (metrics.length > 0) {
      title += `\n${metrics.join(" · ")}`;
    }

    return title;
  }

  const items = $derived<RibbonItem[]>(
    agents.map((a) => ({
      id: a.stationId,
      label: a.agentName,
      status: a.status,
      title: cellTitle(a),
    })),
  );

  // ── Legend ───────────────────────────────────────────────────────────────────
  // One chip per RAW status present (styled via the shared token map), so
  // degraded/starting/sleeping agents get a legend entry instead of silently
  // falling through — the old four-value map made a degraded agent invisible.

  const LEGEND_ORDER = ["error", "degraded", "starting", "running", "sleeping", "stopped", "unknown"];
  const legendRank = (status: string) => {
    const i = LEGEND_ORDER.indexOf(status);
    return i === -1 ? LEGEND_ORDER.length : i;
  };

  const statusCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) {
      counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
    }
    return counts;
  });

  const legendStatuses = $derived(
    [...statusCounts.keys()].sort((a, b) => legendRank(a) - legendRank(b) || a.localeCompare(b)),
  );
</script>

<div class="space-y-3">
  <!-- Grid of agent cells — one per agent, colored by live status -->
  <div aria-label="Fleet heatmap">
    <StatusRibbon {items} size="lg" onSelect={onSelectAgent} cellTestId="heatmap-cell" />
  </div>

  <!-- Legend: status chips with counts, each clickable to filter -->
  <div class="flex flex-wrap gap-2" aria-label="Heatmap legend">
    {#each legendStatuses as status (status)}
      <button
        type="button"
        class="rounded-md border px-2 py-0.5 font-mono text-xs lowercase transition-opacity hover:opacity-80 {statusBadgeClass(status)}"
        data-testid="legend-chip"
        data-status={status}
        onclick={() => onFilterStatus(status)}
      >
        {status} · {statusCounts.get(status)}
      </button>
    {/each}
  </div>
</div>
