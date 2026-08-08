<script lang="ts">
  import type { FleetAgent } from "@agentpod/contract";
  import { Status } from "$lib/components/ui/status";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";

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

<!-- The panel shrinks when there's nothing wrong: a single quiet line when
     healthy, a full bordered panel only when something needs a human. -->
{#if notRunning.length === 0 && offlineNodes === 0 && updatesAvailable === 0}
  <p
    class="flex items-center gap-1.5 text-xs text-muted-foreground"
    data-testid="all-healthy"
  >
    <CircleCheckIcon class="h-3.5 w-3.5 text-status-running" aria-hidden="true" />
    All agents healthy
  </p>
{:else}
  <div class="rounded-lg border border-status-error/30 p-4 space-y-2" data-testid="needs-attention">
    <h2 class="t-section">Needs attention</h2>
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
  </div>
{/if}
