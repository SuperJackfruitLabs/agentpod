<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { stations, loadDetected, adopt, loadAdopted } from "$lib/stores/stations.svelte";
  import { listNodes, updateNode } from "$lib/api/client";
  import { toast } from "svelte-sonner";
  import type { NodeSummary } from "@agentpod/contract";
  import StationTree from "$lib/components/stations/StationTree.svelte";
  import ProvisionedNodeControls from "$lib/components/fleet/ProvisionedNodeControls.svelte";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import Empty from "$lib/components/ui/empty/empty.svelte";
  import HarnessBadge from "$lib/components/fleet/HarnessBadge.svelte";
  import PageHeader from "$lib/components/page-header.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";

  // params.id is always defined for this route
  const id = $derived(page.params.id as string);

  let node = $state<NodeSummary | null>(null);

  async function loadNode() {
    try {
      const all = await listNodes();
      node = all.find((n) => n.id === id) ?? null;
    } catch {
      // non-fatal: node info is best-effort; stations still load
    }
  }

  function loadStations() {
    loadDetected(id);
    loadAdopted(id);
  }

  function retryAll() {
    loadStations();
    loadNode();
  }

  onMount(() => {
    retryAll();
  });

  let updating = $state(false);

  async function handleUpdate() {
    if (!node) return;
    updating = true;
    try {
      const result = await updateNode(node.id);
      if (result.ok) {
        // Keep "updating…" state — the node will blip offline→online on the
        // new version; next refresh clears updateAvailable.
      } else {
        updating = false;
        toast.error("Update failed", { description: result.error ?? "Unknown error" });
      }
    } catch (e) {
      updating = false;
      toast.error("Update failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  async function handleAdopt(key: string) {
    await adopt(id, [key]);
  }

  async function handleAdoptAll() {
    const unadopted = stations.detected.filter((s) => !s.adopted);
    if (unadopted.length === 0) return;
    await adopt(id, unadopted.map((s) => s.key));
  }

  function isAlreadyAdopted(key: string): boolean {
    return stations.adopted.some((s) => s.stationKey === key);
  }

  const headerStatus = $derived(
    node
      ? {
          label: node.status,
          variant: (node.status === "online" ? "running" : "stopped") as "running" | "stopped",
        }
      : undefined,
  );
</script>

<PageHeader title={node?.hostname ?? id} status={headerStatus}>
  {#snippet leading()}
    <a
      href="/"
      class="text-muted-foreground hover:text-foreground transition-colors"
      aria-label="Back to fleet"
    >
      <ArrowLeftIcon class="w-4 h-4" />
    </a>
  {/snippet}
  {#snippet actions()}
    {#if node}
      <span class="text-xs font-mono text-muted-foreground">
        {node.agentVersion ?? "unknown"}
      </span>
      {#if node.updateAvailable}
        <span class="text-xs text-status-degraded">
          update: {node.agentVersion} → {node.latestVersion}
        </span>
        <Button variant="outline" size="sm" disabled={updating} onclick={handleUpdate}>
          {updating ? "Updating…" : "Update"}
        </Button>
      {/if}
    {/if}
  {/snippet}
</PageHeader>

<div class="container mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
  <!-- Provisioned runtime controls (destroy / stop / start) -->
  {#if node?.provisioned}
    <ProvisionedNodeControls {node} onRefresh={loadNode} />
  {/if}

  {#if stations.error}
    <div class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4" role="alert">
      <p class="text-sm text-destructive">{stations.error}</p>
      <Button variant="outline" size="sm" onclick={retryAll}>Retry</Button>
    </div>
  {/if}

  <!-- Detected Stations section -->
  <section class="space-y-3">
    <div class="flex items-center justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold">Detected Stations</h2>
        <p class="text-sm text-muted-foreground">Ready to adopt</p>
      </div>
      {#if stations.detected.filter((s) => !isAlreadyAdopted(s.key)).length > 0}
        <Button
          variant="outline"
          size="sm"
          onclick={handleAdoptAll}
          disabled={stations.isLoading}
          class="shrink-0"
        >
          Adopt all
        </Button>
      {/if}
    </div>

    {#if stations.isLoading}
      <div class="flex flex-col gap-2">
        {#each [1, 2] as _}
          <Skeleton class="h-16 rounded-xl" />
        {/each}
      </div>
    {:else if stations.detected.length === 0}
      <Empty title="No stations detected" />
    {:else}
      <div class="flex flex-col gap-2 md:grid md:grid-cols-2 lg:grid-cols-3">
        {#each stations.detected as s (s.key)}
          <Card.Root class="transition-colors hover:border-primary/40">
            <Card.Content class="flex items-center justify-between gap-3 p-4">
              <div class="flex flex-col gap-1 min-w-0">
                <span class="text-sm font-semibold truncate">{s.displayName}</span>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <HarnessBadge harness={s.harness} />
                  <span class="text-xs text-muted-foreground">{s.kind}</span>
                </div>
                {#if s.workspacePath}
                  <code class="text-xs text-muted-foreground font-mono truncate" title={s.workspacePath}>{s.workspacePath}</code>
                {/if}
              </div>
              {#if !isAlreadyAdopted(s.key)}
                <Button
                  size="sm"
                  onclick={() => handleAdopt(s.key)}
                  disabled={stations.isLoading}
                  class="shrink-0"
                >
                  Adopt
                </Button>
              {:else}
                <Badge variant="secondary" class="shrink-0">Adopted</Badge>
              {/if}
            </Card.Content>
          </Card.Root>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Adopted Stations section -->
  <section class="space-y-3">
    <div>
      <h2 class="text-lg font-semibold">Adopted Stations</h2>
      <p class="text-sm text-muted-foreground">Active workspaces</p>
    </div>

    {#if stations.isLoading}
      <div class="flex flex-col gap-2">
        {#each [1, 2] as _}
          <Skeleton class="h-12 rounded-xl" />
        {/each}
      </div>
    {:else if stations.adopted.length === 0}
      <Empty title="No stations adopted yet" />
    {:else}
      <StationTree stations={stations.adopted} nodeId={id} />
    {/if}
  </section>
</div>
