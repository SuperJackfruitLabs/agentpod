<script lang="ts">
  import type { FleetStats } from "@agentpod/contract";

  let { stats }: { stats: FleetStats } = $props();
</script>

<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
  <!-- Nodes stat -->
  <div class="rounded-lg border p-4 space-y-1">
    <div class="text-xs text-muted-foreground">Nodes online</div>
    <div class="font-mono text-2xl font-semibold text-foreground" data-testid="stat-nodes">
      {stats.nodes.online}<span class="text-muted-foreground text-lg">/{stats.nodes.total}</span>
    </div>
  </div>

  <!-- Agents stat -->
  <div class="rounded-lg border p-4 space-y-1">
    <div class="text-xs text-muted-foreground">Agents</div>
    <div class="font-mono text-2xl font-semibold text-foreground" data-testid="stat-agents">
      {stats.agents.total}
    </div>
  </div>

  <!-- Updates available stat — accent when >0 -->
  <div
    class="rounded-lg border p-4 space-y-1 {stats.updatesAvailable > 0 ? 'border-status-running/50' : ''}"
  >
    <div class="text-xs text-muted-foreground">Updates available</div>
    <div
      class="font-mono text-2xl font-semibold {stats.updatesAvailable > 0 ? 'text-status-running' : 'text-foreground'}"
      data-testid="stat-updates"
    >
      {stats.updatesAvailable}
    </div>
  </div>
</div>
