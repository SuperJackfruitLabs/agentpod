<script lang="ts">
  import type { FleetAgent } from "@agentpod/contract";

  let {
    agents,
    onSelectAgent,
    onFilterStatus,
  }: {
    agents: FleetAgent[];
    onSelectAgent: (stationId: string) => void;
    onFilterStatus: (status: string) => void;
  } = $props();

  // ── Status → bg class ────────────────────────────────────────────────────────

  const STATUS_CELL_CLASS: Record<string, string> = {
    running: "bg-status-running",
    stopped: "bg-status-stopped/50",
    error: "bg-status-error",
    unknown: "bg-status-stopped/25",
  };

  function cellBgClass(status: string): string {
    return STATUS_CELL_CLASS[status] ?? "bg-status-stopped/25";
  }

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

  // ── Legend ───────────────────────────────────────────────────────────────────

  const STATUSES = ["running", "stopped", "error", "unknown"] as const;

  let statusCounts = $derived.by(() => {
    const counts: Record<string, number> = { running: 0, stopped: 0, error: 0, unknown: 0 };
    for (const agent of agents) {
      counts[agent.status] = (counts[agent.status] ?? 0) + 1;
    }
    return counts;
  });

  const LEGEND_CLASS: Record<string, string> = {
    running: "bg-status-running/20 text-status-running border-status-running/40 hover:bg-status-running/30",
    stopped: "bg-status-stopped/20 text-status-stopped border-status-stopped/40 hover:bg-status-stopped/30",
    error: "bg-status-error/20 text-status-error border-status-error/40 hover:bg-status-error/30",
    unknown: "bg-status-stopped/10 text-status-stopped/60 border-status-stopped/20 hover:bg-status-stopped/20",
  };
</script>

<div class="space-y-3">
  <!-- Grid of agent cells — one per agent, colored by live status -->
  <div class="flex flex-wrap gap-1" aria-label="Fleet heatmap">
    {#each agents as agent (agent.stationId)}
      <button
        type="button"
        class="w-5 h-5 rounded-sm {cellBgClass(agent.status)} opacity-80 hover:opacity-100 transition-opacity focus:outline-none focus:ring-1 focus:ring-ring"
        title={cellTitle(agent)}
        aria-label="{agent.agentName} ({agent.status})"
        data-testid="heatmap-cell"
        data-status={agent.status}
        onclick={() => onSelectAgent(agent.stationId)}
      ></button>
    {/each}
  </div>

  <!-- Legend: status chips with counts, each clickable to filter -->
  <div class="flex flex-wrap gap-2" aria-label="Heatmap legend">
    {#each STATUSES as status}
      {#if statusCounts[status] > 0}
        <button
          type="button"
          class="font-mono text-[10px] px-2 py-0.5 rounded border transition-colors {LEGEND_CLASS[status]}"
          data-testid="legend-chip"
          data-status={status}
          onclick={() => onFilterStatus(status)}
        >
          {status} · {statusCounts[status]}
        </button>
      {/if}
    {/each}
  </div>
</div>
