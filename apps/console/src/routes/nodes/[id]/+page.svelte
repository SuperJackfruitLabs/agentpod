<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { stations, loadDetected, adopt, loadAdopted } from "$lib/stores/stations.svelte";
  import { listNodes, updateNode } from "$lib/api/client";
  import { toast } from "svelte-sonner";
  import type { NodeSummary } from "@agentpod/contract";
  import StationTree from "$lib/components/stations/StationTree.svelte";
  import ProvisionedNodeControls from "$lib/components/fleet/ProvisionedNodeControls.svelte";
  import PosturePanel from "$lib/components/fleet/PosturePanel.svelte";
  import * as Card from "$lib/components/ui/card";
  import Empty from "$lib/components/ui/empty/empty.svelte";
  import StateDot from "$lib/components/shell/StateDot.svelte";
  import { nodeState } from "$lib/fleet/state";
  import { relativeTime } from "$lib/utils/relative-time";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import PurposeField from "$lib/components/purpose/PurposeField.svelte";
  import { nodePurposeConsequence } from "$lib/components/purpose/purpose";
  import { setNodePurpose } from "$lib/api/client";

  // params.id is always defined for this route
  const id = $derived(page.params.id as string);

  let node = $state<NodeSummary | null>(null);

  /** Node-level capability, carried in the hello frame. Absent on nodes that
   *  predate it, which is how they degrade to showing no panel at all. */
  const hasPosture = $derived(
    Array.isArray(node?.capabilities) && node!.capabilities.includes("posture")
  );

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
      if (result.ok && result.updating === false) {
        // The node was already on the latest release and did not restart, so
        // nothing will ever clear a spinner here (issue #296).
        updating = false;
        toast.success("Already up to date", {
          description: `This node is running ${result.tag ?? "the latest release"}.`,
        });
      } else if (result.ok) {
        // Keep "updating…" state — the node will blip offline→online on the
        // new version; next refresh clears updateAvailable.
      } else {
        updating = false;
        toast.error("Couldn’t update the node", { description: result.error ?? "The node didn’t respond — it may already be restarting. Check back in a minute." });
      }
    } catch (e) {
      updating = false;
      toast.error("Couldn’t update the node", {
        description:
          e instanceof Error
            ? e.message
            : "The node didn’t respond — it may already be restarting. Check back in a minute.",
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

  /**
   * The node's link state. `nodeState` carries the node's OWN words — a machine
   * somebody switched off is Offline, not "Error" — while sharing the error
   * token, so it is as red as a failed agent without being called one.
   */
  const linkState = $derived(nodeState(node?.status ?? "unknown"));
</script>

<svelte:head>
  <title>{node?.name ?? "Node"} · AgentPod</title>
</svelte:head>

<!--
  The node, said once. This was a PageHeader carrying a status badge in the old
  vocabulary; it is the same header language the station page uses now — a dot,
  a mono name, and one prose line of the facts underneath.

  `relative` is load-bearing: StateDot's label is an sr-only span, which is
  position:absolute, and without a positioned ancestor it escapes any clipping
  container and adds to the document's scroll width.
-->
<header class="relative border-b border-border bg-background">
  <div class="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-6">
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        <a
          href="/nodes"
          class="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          aria-label="Back to nodes"
        >
          <ArrowLeftIcon class="h-4 w-4" />
        </a>
        <StateDot state={linkState} />
        <h1
          class="truncate font-mono text-[21px] leading-tight font-medium"
          title={node?.name ?? id}
        >
          {node?.name ?? id}
        </h1>
      </div>
      <p class="mt-1 truncate text-sm text-muted-foreground" data-testid="node-summary">
        {#if node}
          <!-- Mono for the machine-issued halves only; the joins are prose. -->
          {#if node.hostname !== node.name}
            <span class="font-mono">{node.hostname}</span> ·
          {/if}
          <span class="font-mono">
            {node.os} · {node.arch} · {node.cpuCount} CPU{node.cpuCount === 1 ? "" : "s"}
          </span>
          · {linkState.label} · last seen {relativeTime(node.lastSeenAt)}
        {:else}
          Loading this node…
        {/if}
      </p>
    </div>

    {#if node}
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        {#if node.updateAvailable}
          <!-- Drift wears the `unknown` colour: a node on an old binary is not
               broken, it is unaccounted for until somebody rolls it. -->
          <span class="font-mono text-xs whitespace-nowrap text-status-unknown">
            {node.agentVersion} → {node.latestVersion}
          </span>
          <Button variant="outline" size="sm" disabled={updating} onclick={handleUpdate}>
            {updating ? "Updating…" : "Update"}
          </Button>
        {:else}
          <span class="font-mono text-xs text-muted-foreground">{node.agentVersion ?? "—"}</span>
        {/if}
      </div>
    {/if}
  </div>
</header>

<div class="container mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
  <!-- Provisioned runtime controls (destroy / stop / start) -->
  {#if node?.provisioned}
    <ProvisionedNodeControls {node} onRefresh={loadNode} />
  {/if}

  {#if hasPosture}
    <PosturePanel nodeId={id} />
  {/if}

  <!--
    What the agents on this node are FOR. The node's own field is only the
    default a future adoption inherits — an agent's purpose lives on the agent —
    but setting it also labels the ones here that have none, which is what makes
    an existing fleet filable without visiting every agent in turn. The hint
    says how many that is before the click, not after.
  -->
  {#if node}
    <Card.Root>
      <Card.Content class="p-4">
        <PurposeField
          id="node-purpose"
          label="Purpose of agents here"
          value={node.purpose ?? null}
          hint={nodePurposeConsequence(
            stations.adopted.filter((s) => s.purpose === null).length
          )}
          onSave={async (purpose) => {
            await setNodePurpose(id, purpose);
            await Promise.all([loadNode(), loadAdopted(id)]);
          }}
        />
      </Card.Content>
    </Card.Root>
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
        <h2 class="t-section">Detected agents</h2>
        <p class="text-sm text-muted-foreground">Found on this node, not yet added</p>
      </div>
      {#if stations.detected.filter((s) => !isAlreadyAdopted(s.key)).length > 0}
        <Button
          variant="outline"
          size="sm"
          onclick={handleAdoptAll}
          disabled={stations.isLoading}
          class="shrink-0"
        >
          Add all agents
        </Button>
      {/if}
    </div>

    {#if stations.isLoading}
      <div class="flex flex-col gap-2">
        {#each [1, 2] as _}
          <Skeleton class="h-16 rounded-lg" />
        {/each}
      </div>
    {:else if stations.detected.length === 0}
      <Empty
        title="No agents found on this node"
        description="AgentPod looks for hermes, openclaw, claude-code, codex, opencode, and pi. Start one and rescan."
      >
        <Button variant="outline" size="sm" onclick={loadStations}>Rescan</Button>
      </Empty>
    {:else}
      <!--
        One table, not fifteen cards. A node with a dozen detected agents used
        to be a grid of near-identical boxes whose only varying content was the
        word "Added" — the shape said "browse these", when the only question
        being asked is which of them to add.

        Four columns do not fit a phone; they scroll in here rather than
        dragging the document sideways.
      -->
      <div data-testid="detected-table-scroller" class="overflow-x-auto rounded-lg border border-border">
        <table class="w-full min-w-[640px] text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" class="px-3 py-2 font-medium">Agent</th>
              <th scope="col" class="px-3 py-2 font-medium">Harness</th>
              <th scope="col" class="px-3 py-2 font-medium">Kind</th>
              <th scope="col" class="px-3 py-2 font-medium">Workspace path</th>
              <!-- `relative`: the sr-only span below is position:absolute and
                   would otherwise escape this scroller and widen the document. -->
              <th scope="col" class="relative px-3 py-2 font-medium">
                <span class="sr-only">Add</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {#each stations.detected as s (s.key)}
              <tr data-testid="detected-row" class="relative border-b border-border/50 last:border-b-0">
                <td class="max-w-[220px] px-3 py-2">
                  <span class="block truncate font-mono font-medium" title={s.displayName}>
                    {s.displayName}
                  </span>
                </td>
                <td class="px-3 py-2 font-mono text-xs text-muted-foreground">{s.harness}</td>
                <td class="px-3 py-2 font-mono text-xs text-muted-foreground">{s.kind}</td>
                <td class="max-w-[280px] px-3 py-2">
                  {#if s.workspacePath}
                    <span
                      class="block truncate font-mono text-xs text-muted-foreground"
                      title={s.workspacePath}
                    >
                      {s.workspacePath}
                    </span>
                  {:else}
                    <span class="text-xs text-muted-foreground">—</span>
                  {/if}
                </td>
                <td class="px-3 py-2 text-right">
                  {#if !isAlreadyAdopted(s.key)}
                    <Button
                      size="sm"
                      class="h-7 px-2 text-xs"
                      onclick={() => handleAdopt(s.key)}
                      disabled={stations.isLoading}
                    >
                      Add agent
                    </Button>
                  {:else}
                    <span class="text-xs text-muted-foreground">Added</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <!-- Your agents section -->
  <section class="space-y-3">
    <h2 class="t-section">Your agents</h2>

    {#if stations.isLoading}
      <div class="flex flex-col gap-2">
        {#each [1, 2] as _}
          <Skeleton class="h-12 rounded-lg" />
        {/each}
      </div>
    {:else if stations.adopted.length === 0}
      <Empty
        title="No agents added yet"
        description="Add a detected agent above to start monitoring it."
      />
    {:else}
      <StationTree stations={stations.adopted} nodeId={id} />
    {/if}
  </section>
</div>
