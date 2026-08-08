<script lang="ts">
  import type { FleetAgent } from "@agentpod/contract";
  import { Status } from "$lib/components/ui/status";

  let { agents }: { agents: FleetAgent[] } = $props();

  let notRunning = $derived(agents.filter((a) => a.status !== "running"));
  let offlineNodes = $derived(
    [...new Set(
      agents
        .filter((a) => a.nodeStatus === "offline")
        .map((a) => a.nodeId)
    )].length
  );
  let updatesAvailable = $derived(agents.filter((a) => a.updateAvailable).length);
</script>

<div class="rounded-lg border p-4 space-y-2" data-testid="needs-attention">
  <p class="text-sm font-medium">Needs attention</p>

  {#if notRunning.length === 0 && offlineNodes === 0 && updatesAvailable === 0}
    <p class="text-xs text-status-running" data-testid="all-healthy">all healthy ✓</p>
  {:else}
    <ul class="space-y-1">
      {#each notRunning as agent (agent.stationId)}
        <li>
          <a
            href="/agents?station={agent.stationId}"
            class="text-xs flex items-center gap-1.5 hover:text-primary transition-colors"
            data-testid="attention-agent"
          >
            <span class="text-foreground">{agent.agentName}</span>
            <span class="text-muted-foreground/60">·</span>
            <Status form="text" status={agent.status} class="text-xs" />
          </a>
        </li>
      {/each}

      {#if offlineNodes > 0}
        <li>
          <a
            href="/nodes"
            class="text-xs flex items-center gap-1.5 hover:text-primary transition-colors"
            data-testid="attention-offline-nodes"
          >
            <span class="text-foreground">{offlineNodes} node{offlineNodes !== 1 ? "s" : ""} offline</span>
          </a>
        </li>
      {/if}

      {#if updatesAvailable > 0}
        <li>
          <a
            href="/agents?updates=1"
            class="text-xs flex items-center gap-1.5 hover:text-primary transition-colors"
            data-testid="attention-updates"
          >
            <span class="text-foreground">{updatesAvailable} update{updatesAvailable !== 1 ? "s" : ""} available</span>
          </a>
        </li>
      {/if}
    </ul>
  {/if}
</div>
