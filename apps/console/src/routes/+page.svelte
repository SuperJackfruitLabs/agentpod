<script lang="ts">
  /**
   * The muster — the console's home.
   *
   * It replaces a stat band, a status ribbon, a heatmap, a "needs attention"
   * card and a recent-activity card: five panels that between them never
   * answered "what needs me?", and one of which reported "5 stopped" for what
   * was four stopped and one unknown. There are four things here instead: the
   * fleet stated in a sentence, one stacked state bar, the nodes you can act
   * on, and what the fleet has been doing.
   *
   * It reads the shared fleet store and starts NO poll — AppShell holds the
   * one reference for the whole console. Activity is loaded once here rather
   * than polled: it is a log, and the page is not a dashboard to leave open.
   */
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { createEnrollmentToken, listActivity, updateNode, type ActivityRow } from "$lib/api/client";
  import { toast } from "svelte-sonner";
  import { deriveAttention } from "$lib/fleet/attention";
  import { nodeState, stationState, type StateId } from "$lib/fleet/state";
  import { fleet } from "$lib/stores/fleet.svelte";
  import ActivityFeed from "$lib/components/fleet/ActivityFeed.svelte";
  import ConnectBanner from "$lib/components/fleet/connect-banner.svelte";
  import StateBar from "$lib/components/shell/StateBar.svelte";
  import StateDot from "$lib/components/shell/StateDot.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { relativeTime } from "$lib/utils/relative-time";

  // ── The fleet in words ──────────────────────────────────────────────────────

  const agentCount = $derived(fleet.agents.length);
  const nodeCount = $derived(fleet.nodes.length);

  const headline = $derived(
    `${agentCount} ${agentCount === 1 ? "agent" : "agents"} on ${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}.`,
  );

  /**
   * Exactly the lane's list, so the number here and the number in the lane's
   * badge can never disagree — deriving "needs you" twice is how the old
   * Overview ended up contradicting itself.
   */
  const needsYou = $derived(
    deriveAttention({
      agents: fleet.agents,
      nodes: fleet.nodes,
      runtimes: fleet.runtimes,
      stations: fleet.stations,
      principals: fleet.principals,
    }).length,
  );

  const needsYouLine = $derived(
    needsYou === 0
      ? "Nothing needs you."
      : needsYou === 1
        ? "1 needs you."
        : `${needsYou} need you.`,
  );

  // ── The bar ─────────────────────────────────────────────────────────────────

  const stateCounts = $derived.by(() => {
    const counts: Partial<Record<StateId, number>> = {};
    for (const agent of fleet.agents) {
      const id = stationState(agent.status).id;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  });

  // ── The nodes table ─────────────────────────────────────────────────────────

  const agentsPerNode = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const agent of fleet.agents) counts.set(agent.nodeId, (counts.get(agent.nodeId) ?? 0) + 1);
    return counts;
  });

  let updating = $state<Record<string, boolean>>({});

  async function handleUpdate(id: string) {
    updating[id] = true;
    try {
      const result = await updateNode(id);
      if (result.ok && result.updating === false) {
        // The node was already on the latest release and never restarted, so
        // nothing would ever clear the spinner (issue #296).
        delete updating[id];
        toast.success("Already up to date", {
          description: `This node is running ${result.tag ?? "the latest release"}.`,
        });
      } else if (result.ok) {
        // Leave it spinning: the node blips offline→online on the new version
        // and the next fleet refresh clears updateAvailable.
      } else {
        delete updating[id];
        toast.error("Couldn’t update the node", { description: result.error ?? "The node didn’t respond." });
      }
    } catch (e) {
      delete updating[id];
      toast.error("Couldn’t update the node", {
        description: e instanceof Error ? e.message : "The node didn’t respond.",
      });
    }
  }

  // ── Activity ────────────────────────────────────────────────────────────────

  let activity = $state<ActivityRow[]>([]);
  let activityError = $state<string | null>(null);

  // ── First node ──────────────────────────────────────────────────────────────

  let lastToken = $state<string | null>(null);

  async function handleCreateToken() {
    try {
      const result = await createEnrollmentToken();
      lastToken = result.token;
    } catch {
      // Non-fatal in the empty state — ConnectBanner shows its own error.
    }
  }

  onMount(() => {
    void (async () => {
      try {
        activity = await listActivity();
      } catch (e) {
        // A failed fetch must never masquerade as "No activity yet".
        activityError = e instanceof Error ? e.message : "Couldn’t load activity.";
      }
    })();
  });

  /** True only while we have never had data — a refresh must not flash a skeleton. */
  const showSkeleton = $derived(fleet.isLoading && fleet.loadedAt === null);
</script>

<svelte:head>
  <title>Overview · AgentPod</title>
</svelte:head>

<div class="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 sm:px-6">
  {#if showSkeleton}
    <Skeleton class="h-16 w-2/3 rounded-lg" />
    <Skeleton class="h-3 w-full rounded-full" />
    <Skeleton class="h-40 w-full rounded-lg" />

  {:else if fleet.error && nodeCount === 0}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-status-error/50 bg-status-error/5 p-4"
      role="alert"
    >
      <p class="text-sm text-status-error">{fleet.error}</p>
    </div>

  {:else if nodeCount === 0}
    <!-- Nothing is enrolled yet, so the only useful thing this page can do is
         hand over the command that enrolls something. -->
    <div class="mx-auto w-full max-w-2xl">
      {#if lastToken}
        <div class="space-y-3 rounded-lg border p-6">
          <p class="text-xs text-muted-foreground">
            Enrollment token created — run this on the node you want to connect
          </p>
          <code class="block break-all font-mono text-sm">
            curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh | sudo bash -s -- {lastToken}
          </code>
          <p class="text-xs text-muted-foreground">The node joins the fleet as soon as it connects.</p>
        </div>
      {:else}
        <ConnectBanner onCreateToken={handleCreateToken} />
      {/if}
    </div>

  {:else}
    <!-- ── The hero: the fleet, in a sentence ────────────────────────────── -->
    <header class="space-y-1">
      <h1 data-testid="muster-hero" class="text-3xl font-semibold tracking-tight text-foreground">
        {headline}
      </h1>
      <p
        data-testid="muster-needs-you"
        class={needsYou > 0 ? "text-lg text-status-unknown" : "text-lg text-status-running"}
      >
        {needsYouLine}
      </p>
    </header>

    <!-- ── One bar, six states, unknown counted as itself ─────────────────── -->
    <div data-testid="muster-state-bar">
      <StateBar counts={stateCounts} onselect={(id) => goto(`/agents?status=${id}`)} />
    </div>

    <!-- ── The nodes ──────────────────────────────────────────────────────── -->
    <section class="space-y-2">
      <h2 class="text-sm font-medium text-muted-foreground">Where they run</h2>

      <!-- Seven columns do not fit a phone; they scroll in here rather than
           dragging the document sideways. -->
      <div data-testid="nodes-table-scroller" class="overflow-x-auto rounded-lg border border-border">
        <table class="w-full min-w-[720px] text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" class="px-3 py-2 font-medium">Node</th>
              <th scope="col" class="px-3 py-2 font-medium">Link</th>
              <th scope="col" class="px-3 py-2 font-medium">Agents</th>
              <th scope="col" class="px-3 py-2 font-medium">Last seen</th>
              <th scope="col" class="px-3 py-2 font-medium">Node agent</th>
              <th scope="col" class="px-3 py-2 font-medium">Posture</th>
              <!--
                `relative` for the same reason the rows carry it: this sr-only
                span is position:absolute, and with no positioned ancestor it
                escaped the table's overflow-x-auto and set the DOCUMENT's
                scroll width to 667px at a 414px viewport. Measured.
              -->
              <th scope="col" class="relative px-3 py-2 font-medium"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each fleet.nodes as node (node.id)}
              <!--
                `relative` is load-bearing: the Link cell holds a StateDot,
                whose sr-only label is position:absolute. With no positioned
                ancestor its containing block is the initial one, so the
                surrounding overflow:hidden does NOT clip it and it adds to
                the document's scroll width — that is how the attention lane
                dragged a 1500px viewport to 1828px.
              -->
              <tr data-testid="node-row" class="relative border-b border-border/50 last:border-b-0">
                <!-- Capped and truncating: a node name is free text, and an
                     uncapped one took 425px of a 918px table, measured. -->
                <td class="max-w-[220px] px-3 py-2">
                  <a
                    href="/nodes/{node.id}"
                    title={node.name}
                    class="block truncate font-mono text-foreground underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  >
                    {node.name}
                  </a>
                  <span class="block truncate text-xs text-muted-foreground">{node.os} · {node.arch}</span>
                </td>

                <td data-testid="node-link-{node.id}" class="relative px-3 py-2">
                  <StateDot state={nodeState(node.status)} withLabel size="sm" />
                </td>

                <td data-testid="node-agents-{node.id}" class="px-3 py-2 font-mono tabular-nums">
                  {agentsPerNode.get(node.id) ?? 0}
                </td>

                <td class="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {relativeTime(node.lastSeenAt)}
                </td>

                <td class="px-3 py-2">
                  {#if node.updateAvailable}
                    <span data-testid="node-drift-{node.id}" class="font-mono text-xs text-status-unknown">
                      {node.agentVersion} → {node.latestVersion}
                    </span>
                  {:else}
                    <span class="font-mono text-xs text-muted-foreground">{node.agentVersion ?? "—"}</span>
                  {/if}
                </td>

                <td class="px-3 py-2 text-xs">
                  {#if node.capabilities?.includes("posture")}
                    <a
                      href="/nodes/{node.id}"
                      class="text-muted-foreground underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                    >
                      Scan
                    </a>
                  {:else}
                    <span class="text-muted-foreground" title="This node's agent doesn't report posture">—</span>
                  {/if}
                </td>

                <td class="px-3 py-2 text-right">
                  {#if node.updateAvailable}
                    <Button
                      data-testid="node-update-{node.id}"
                      variant="outline"
                      size="sm"
                      class="h-7 px-2 text-xs"
                      disabled={updating[node.id]}
                      onclick={() => handleUpdate(node.id)}
                    >
                      {updating[node.id] ? "Updating…" : "Update"}
                    </Button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── What it has been doing ─────────────────────────────────────────── -->
    <section class="space-y-2">
      <div class="flex items-baseline justify-between">
        <h2 class="text-sm font-medium text-muted-foreground">Lately</h2>
        <a
          href="/activity"
          class="text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          All activity
        </a>
      </div>

      {#if activityError}
        <p class="text-sm text-status-error" role="alert">{activityError}</p>
      {:else}
        <ActivityFeed rows={activity} limit={8} />
      {/if}
    </section>
  {/if}
</div>
