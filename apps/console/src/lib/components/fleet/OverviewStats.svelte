<script lang="ts">
  /**
   * The Overview stat band, health first: the number an operator opens this
   * page for is "how many agents are not running", so status counts lead in
   * status colors and machine inventory follows as one quiet line.
   */
  import type { FleetStats, FleetAgent } from "@agentpod/contract";
  import { tokenFor, statusTextClass, type StatusToken } from "$lib/utils/status-badge";

  let { stats, agents }: { stats: FleetStats; agents: FleetAgent[] } = $props();

  // running leads; problem states follow in severity order; zero-count
  // problem states are omitted (the band shrinks when all is well).
  const ORDER: StatusToken[] = ["running", "error", "degraded", "starting", "sleeping", "stopped"];

  const counts = $derived.by(() => {
    const c = new Map<StatusToken, number>();
    for (const a of agents) {
      const t = tokenFor(a.status);
      c.set(t, (c.get(t) ?? 0) + 1);
    }
    return c;
  });

  const bands = $derived(ORDER.filter((t) => t === "running" || (counts.get(t) ?? 0) > 0));
</script>

<div class="rounded-lg border p-4 space-y-3">
  <!-- Health: the numbers this page exists for -->
  <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2" data-testid="health-band">
    {#each bands as token (token)}
      <div class="flex items-baseline gap-1.5">
        <span class="t-metric {statusTextClass(token)}" data-testid="stat-{token}"
          >{counts.get(token) ?? 0}</span
        >
        <span class="t-label">{token}</span>
      </div>
    {/each}
  </div>

  <!-- Inventory: quiet, mono values -->
  <p class="text-xs text-muted-foreground" data-testid="inventory-line">
    <span class="font-mono tabular-nums" data-testid="stat-nodes"
      >{stats.nodes.online}/{stats.nodes.total}</span
    >
    nodes online ·
    <span class="font-mono tabular-nums" data-testid="stat-agents">{stats.agents.total}</span>
    agents ·
    <span
      class="font-mono tabular-nums {stats.updatesAvailable > 0 ? 'text-status-degraded' : ''}"
      data-testid="stat-updates">{stats.updatesAvailable}</span
    >
    updates available
  </p>
</div>
