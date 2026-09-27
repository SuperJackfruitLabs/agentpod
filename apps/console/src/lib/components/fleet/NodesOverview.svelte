<script lang="ts">
  /**
   * /nodes — the machines, as an ops table.
   *
   * The same table the muster draws, with the things only this page can do
   * attached to it: minting an enrollment token, provisioning a runtime, and
   * rolling the whole fleet onto a new agent release. Card chrome is gone —
   * the status badges, the ribbon of per-agent pips and the three skeleton
   * cards were three different visual languages for "what state is this in",
   * and the console now has one: a dot and a word from `state.ts`.
   *
   * The Link column says Online / Offline, not Running / Error. `nodeState`
   * carries the node's own words on purpose: a machine somebody closed the lid
   * on is offline, not errored, and only a process runs.
   */
  import { onMount } from "svelte";
  import { startPolling } from "$lib/utils/poll";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { listNodes, createEnrollmentToken, listRuntimes, listRuntimeProviders, updateNode, updateAllNodes, getFleet, type DriverManifest } from "$lib/api/client";
  import { toast } from "svelte-sonner";
  import type { NodeSummary, ProvisionedRuntime, FleetAgent } from "@agentpod/contract";
  import StateDot from "$lib/components/shell/StateDot.svelte";
  import { nodeState, stationState, STATE } from "$lib/fleet/state";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import PageHeader from "$lib/components/page-header.svelte";
  import EnrollmentCommand from "./EnrollmentCommand.svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import ArrowUpCircleIcon from "@lucide/svelte/icons/arrow-up-circle";
  import NewRuntimeDialog from "./NewRuntimeDialog.svelte";
  import ConnectBanner from "./connect-banner.svelte";

  import { enrollmentCommand } from "$lib/utils/enrollment-command";
  import { relativeTime } from "$lib/utils/relative-time";

  let nodes = $state<NodeSummary[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let lastToken = $state<string | null>(null);
  let isMinting = $state(false);
  let mintError = $state<string | null>(null);

  // Fleet agents, grouped per node, drive the Agents column.
  let fleetAgents = $state<FleetAgent[]>([]);

  const agentsByNode = $derived.by(() => {
    const m = new Map<string, FleetAgent[]>();
    for (const a of fleetAgents) {
      const list = m.get(a.nodeId) ?? [];
      list.push(a);
      m.set(a.nodeId, list);
    }
    return m;
  });

  // Runtime provisioning state
  let runtimes = $state<ProvisionedRuntime[]>([]);
  let providers = $state<string[]>(["docker", "cloudflare"]);
  let manifests = $state<DriverManifest[]>([]);
  let showNewRuntimeDialog = $state(false);

  // Provisioning runtimes: status==="provisioning" with no matching online node yet
  let provisioningRuntimes = $derived(
    runtimes.filter(
      (r) =>
        r.status === "provisioning" &&
        !nodes.some((n) => n.id === r.nodeId && n.status === "online")
    )
  );

  function resolvedHubUrl(): string {
    const stored =
      typeof window !== "undefined" ? window.localStorage.getItem("agentpod.apiUrl") : null;
    return stored ?? import.meta.env.PUBLIC_HUB_URL ?? "http://localhost:3001";
  }

  async function loadData(background = false) {
    if (!background) {
      isLoading = true;
      error = null;
    }
    try {
      const [nodesResult, runtimesResult, fleetResult] = await Promise.allSettled([
        listNodes(),
        listRuntimes(),
        getFleet(),
      ]);
      if (fleetResult.status === "fulfilled") {
        fleetAgents = fleetResult.value.agents;
      }
      // fleet agents failing is non-fatal — the Agents column shows "—"
      if (nodesResult.status === "fulfilled") {
        nodes = nodesResult.value;
        error = null;
      } else if (!background) {
        // Background refreshes keep the last good data on screen; the shell's
        // hub pill carries the staleness signal.
        error =
          nodesResult.reason instanceof Error
            ? nodesResult.reason.message
            : "Couldn't load nodes.";
      }
      if (runtimesResult.status === "fulfilled") {
        runtimes = runtimesResult.value;
      }
      // runtimes failing is non-fatal — keep the previous value
    } finally {
      if (!background) isLoading = false;
    }
  }

  onMount(() => {
    void (async () => {
      // Fetch enabled providers; fall back to defaults on failure
      try {
        const res = await listRuntimeProviders();
        if (res.providers.length > 0) providers = res.providers;
        if (res.manifests) manifests = res.manifests;
      } catch {
        // keep fallback ["docker", "cloudflare"]
      }
      await loadData();
    })();
    return startPolling(() => void loadData(true), 30_000);
  });

  // ?action=<new-runtime|create-token> handling. This must be a reactive
  // $effect rather than onMount: SvelteKit does not remount this component
  // on same-route navigation, e.g. the command palette navigating from
  // /nodes to /nodes?action=new-runtime while /nodes is already mounted.
  // Reading page.url.searchParams inside $effect re-runs the branch
  // whenever the reactive URL changes, including in place.
  //
  // Loop guard: `replaceState` does NOT reassign the reactive `page.url` in
  // real SvelteKit (it's the shallow-routing API — it patches the history
  // entry, not the page store), and the history entry it writes can still
  // carry the stale "?action=…" query, so a browser back-navigation onto
  // that entry can reconstruct page.url WITH the param again. We can't rely
  // on the param "clearing itself" reactively, so we track the last-handled
  // action value explicitly:
  //   - an action value equal to the one already handled is ignored (blocks
  //     back-nav from reprocessing the same stale param), and
  //   - `handledAction` resets to null whenever the URL has NO action param,
  //     so a later *new* palette invocation (which always drives a real
  //     goto() navigation, clearing the param at some point along the way)
  //     is still processed.
  // The optional chaining also guards test/SSR environments where
  // page.url.searchParams may be absent.
  let handledAction = $state<string | null>(null);
  $effect(() => {
    const action = (page.url as { searchParams?: URLSearchParams } | undefined)?.searchParams?.get("action") ?? null;
    if (!action) {
      handledAction = null;
      return;
    }
    if (action === handledAction) return;
    handledAction = action;
    if (action === "new-runtime") {
      showNewRuntimeDialog = true;
    } else if (action === "create-token") {
      handleCreateToken();
    }
    try {
      replaceState("/nodes", {});
    } catch {
      // non-critical in environments where history is unavailable
    }
  });

  async function handleCreateToken() {
    mintError = null;
    isMinting = true;
    try {
      const result = await createEnrollmentToken();
      lastToken = result.token;
    } catch (e) {
      mintError = e instanceof Error ? e.message : "Failed to create enrollment token";
    } finally {
      isMinting = false;
    }
  }

  async function handleRuntimeCreated() {
    isLoading = true;
    showNewRuntimeDialog = false;
    await loadData();
  }

  // ── Per-node update state (keyed by node id) ──────────────────────────────
  let updatingNodes = $state<Record<string, boolean>>({});

  async function handleUpdate(id: string) {
    updatingNodes[id] = true;
    try {
      const result = await updateNode(id);
      if (result.ok && result.updating === false) {
        // The node was already on the latest release and did not restart, so
        // nothing will ever clear a spinner here (issue #296).
        delete updatingNodes[id];
        toast.success("Already up to date", {
          description: `This node is running ${result.tag ?? "the latest release"}.`,
        });
      } else if (result.ok) {
        // Keep "updating…" state — the node will blip offline→online on the new
        // version and the next nodes refresh will clear updateAvailable.
      } else {
        delete updatingNodes[id];
        toast.error("Couldn’t update the node", { description: result.error ?? "The node didn’t respond — it may already be restarting. Check back in a minute." });
      }
    } catch (e) {
      delete updatingNodes[id];
      toast.error("Couldn’t update the node", {
        description:
          e instanceof Error
            ? e.message
            : "The node didn’t respond — it may already be restarting. Check back in a minute.",
      });
    }
  }

  // ── Copy-to-clipboard for enrollment command ───────────────────────────────
  let copied = $state(false);
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;


  // ─── Fleet rollout (#295) ───────────────────────────────────────────────────

  /**
   * Nodes the hub can see are behind. Drives both the button's presence and its
   * count, so an operator is never offered an action with nothing to do.
   */
  const nodesBehind = $derived(nodes.filter((n) => n.updateAvailable));

  let isRollingOut = $state(false);

  /**
   * Roll the fleet. The hub goes one node at a time and always answers with a
   * row per node, so this reports what actually happened rather than "sent" —
   * a rollout claiming success while machines stayed on the old binary is the
   * exact defect #296 fixed on the single-node path.
   */
  async function handleUpdateAll() {
    isRollingOut = true;
    try {
      const result = await updateAllNodes();
      const { updated = 0, failed = 0, skipped = 0 } = result.summary ?? {};

      if (failed > 0) {
        const names = result.results
          .filter((r) => r.outcome === "failed")
          .map((r) => r.name)
          .join(", ");
        toast.error(`${failed} node${failed === 1 ? "" : "s"} didn’t update`, {
          description: `${names}. ${updated} updated, ${skipped} skipped.`,
        });
      } else if (updated > 0) {
        toast.success(`Updating ${updated} node${updated === 1 ? "" : "s"}`, {
          description:
            "Each will blip offline and come back on the new version. Skipped: " +
            `${skipped}.`,
        });
      } else {
        toast.success("Nothing to update", {
          description: "Every reachable node is already on the latest release.",
        });
      }

      // The updated nodes restart; the next refresh reflects their new version.
      await loadData();
    } catch (e) {
      toast.error("Couldn’t roll out the update", {
        description: e instanceof Error ? e.message : "The hub didn’t respond.",
      });
    } finally {
      isRollingOut = false;
    }
  }

  function handleCopyEnrollCmd() {
    const cmd = enrollmentCommand(resolvedHubUrl(), lastToken ?? "");
    navigator.clipboard.writeText(cmd).then(() => {
      copied = true;
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        copied = false;
        copyTimeout = null;
      }, 2000);
    });
  }
</script>

<PageHeader title="Nodes" subtitle="Connected machines">
  {#snippet actions()}
    <div class="flex flex-col items-end gap-1.5">
      <div class="flex gap-2 flex-wrap justify-end">
        <!--
          Only offered when there is drift to clear (#295). Nodes never update
          themselves — there is no timer anywhere — so after a release the fleet
          sits where it is until someone rolls it. This is that someone's button.
        -->
        {#if nodesBehind.length > 0}
          <Button onclick={handleUpdateAll} disabled={isRollingOut} variant="outline">
            <ArrowUpCircleIcon class="h-4 w-4 mr-2" />
            {isRollingOut
              ? "Updating fleet…"
              : `Update ${nodesBehind.length} node${nodesBehind.length === 1 ? "" : "s"}`}
          </Button>
        {/if}
        <Button onclick={() => (showNewRuntimeDialog = true)} variant="outline">
          <PlusIcon class="h-4 w-4 mr-2" />
          New runtime
        </Button>
        <!--
          Show the "Create enrollment token" header button only when nodes are present
          (or while loading). When nodes=0 the ConnectBanner below supplies the same CTA
          to avoid duplicate accessible buttons.
        -->
        {#if isLoading || nodes.length > 0 || provisioningRuntimes.length > 0}
          <Button onclick={handleCreateToken} disabled={isMinting}>
            <PlusIcon class="h-4 w-4 mr-2" />
            {isMinting ? "Creating…" : "Create enrollment token"}
          </Button>
        {/if}
      </div>
      {#if mintError}<p class="text-xs text-status-error">{mintError}</p>{/if}
    </div>
  {/snippet}
</PageHeader>

<div class="container mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
  <!-- Enrollment command block (only when nodes/runtimes already exist; in empty state it shows in-place) -->
  {#if lastToken && (nodes.length > 0 || provisioningRuntimes.length > 0)}
    <div class="space-y-2">
      <p class="text-xs text-muted-foreground">Run this on the target node to connect it</p>
      <EnrollmentCommand token={lastToken} hubUrl={resolvedHubUrl()} {copied} onCopy={handleCopyEnrollCmd} />
    </div>
  {/if}

  <!-- Loading state: rows, because rows are what arrives -->
  {#if isLoading}
    <div class="space-y-2">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-12 rounded-sm" />
      {/each}
    </div>

  <!-- Error state -->
  {:else if error}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-status-error/50 bg-status-error/5 p-4"
      role="alert"
    >
      <p class="text-sm text-status-error">{error}</p>
      <Button variant="outline" size="sm" onclick={() => loadData()}>Retry</Button>
    </div>

  <!-- Empty state: no nodes and no provisioning runtimes → connect banner or in-place token -->
  {:else if nodes.length === 0 && provisioningRuntimes.length === 0}
    <div class="flex flex-col items-center py-8">
      <div class="w-full max-w-2xl">
        {#if lastToken}
          <div class="space-y-3">
            <p class="text-xs text-muted-foreground">
              Enrollment token created — run this on the target node to connect it
            </p>
            <EnrollmentCommand token={lastToken} hubUrl={resolvedHubUrl()} {copied} onCopy={handleCopyEnrollCmd} />
            <p class="text-xs text-muted-foreground/60">The node will appear below once it connects</p>
          </div>
        {:else}
          <ConnectBanner onCreateToken={handleCreateToken} />
        {/if}
      </div>
    </div>

  {:else}
    <div class="space-y-4">
      <!--
        Runtimes the substrate has accepted but no node has come back from yet.
        A line each, not a tinted card: they are the same "ask in flight" the
        rest of the console draws as a starting dot, and they stop existing the
        moment their node enrols.
      -->
      {#if provisioningRuntimes.length > 0}
        <ul class="divide-y divide-border/50 rounded-lg border border-border" data-testid="provisioning-list">
          {#each provisioningRuntimes as rt (rt.id)}
            <li class="relative flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <StateDot state={STATE.starting} withLabel size="sm" pulse />
              <span class="truncate font-mono font-medium" title={rt.name}>{rt.name}</span>
              <span class="font-mono text-xs text-muted-foreground">
                {rt.provider} · {rt.resourceTier}
                {#if rt.harness && rt.harness !== "none"}
                  · {rt.harness}
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      <!-- Seven columns do not fit a phone; they scroll in here rather than
           dragging the document sideways. Same shape as the muster's table. -->
      <div data-testid="nodes-table-scroller" class="overflow-x-auto rounded-lg border border-border">
        <table class="w-full min-w-[820px] text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" class="px-3 py-2 font-medium">Node</th>
              <th scope="col" class="px-3 py-2 font-medium">Link</th>
              <th scope="col" class="px-3 py-2 font-medium">Agents</th>
              <th scope="col" class="px-3 py-2 font-medium">Last seen</th>
              <th scope="col" class="px-3 py-2 font-medium">Node agent</th>
              <th scope="col" class="px-3 py-2 font-medium">Posture</th>
              <!--
                `relative` is load-bearing: an sr-only span is position:absolute,
                and with no positioned ancestor its containing block is the
                initial one — so it escapes the overflow-x-auto above and adds
                to the DOCUMENT's scroll width. Measured at 414px.
              -->
              <th scope="col" class="relative px-3 py-2 font-medium">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {#each nodes as node (node.id)}
              {@const nodeAgents = agentsByNode.get(node.id) ?? []}
              {@const runningCount = nodeAgents.filter((a) => stationState(a.status).id === "running").length}
              <!--
                `relative` for the Link cell's StateDot: its label is
                position:absolute when not shown inline, and an unpositioned
                ancestor lets it escape the scroller above.
              -->
              <tr data-testid="node-row" class="relative border-b border-border/50 last:border-b-0">
                <!-- Capped and truncating: a node name is free text, and an
                     uncapped 62-character one took 425px of a 918px table. -->
                <td class="max-w-[220px] px-3 py-2">
                  <a
                    href="/nodes/{node.id}"
                    title={node.name}
                    class="block truncate font-mono text-foreground underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  >
                    {node.name}
                  </a>
                  <span class="block truncate text-xs text-muted-foreground" title={node.hostname}>
                    {node.hostname}
                  </span>
                  <span class="block truncate text-xs text-muted-foreground">
                    {node.os} · {node.arch} · {node.cpuCount} CPU{node.cpuCount === 1 ? "" : "s"}
                    {#if node.provisioned}
                      · provisioned · {node.provisioned.provider}
                    {/if}
                  </span>
                </td>

                <td data-testid="node-link-{node.id}" class="relative px-3 py-2">
                  <StateDot state={nodeState(node.status)} withLabel size="sm" />
                </td>

                <td data-testid="node-agents-{node.id}" class="px-3 py-2 font-mono tabular-nums">
                  {#if nodeAgents.length > 0}
                    <span title="{runningCount} of {nodeAgents.length} running">
                      {runningCount}/{nodeAgents.length}
                    </span>
                  {:else}
                    <span class="text-muted-foreground">—</span>
                  {/if}
                </td>

                <td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-muted-foreground">
                  {relativeTime(node.lastSeenAt)}
                </td>

                <td class="px-3 py-2">
                  {#if node.updateAvailable}
                    <!-- Drift is a state worth a colour, and `unknown` is the
                         one it wears: a node on an old binary is not broken,
                         it is unaccounted for until somebody rolls it. -->
                    <span data-testid="node-drift-{node.id}" class="font-mono text-xs whitespace-nowrap text-status-unknown">
                      {node.agentVersion} → {node.latestVersion}
                    </span>
                  {:else}
                    <span class="font-mono text-xs text-muted-foreground">{node.agentVersion ?? "—"}</span>
                  {/if}
                </td>

                <td class="px-3 py-2 text-xs">
                  <!-- A link, not a grade. Posture is a live scan that writes
                       an audit row, so a column that scanned every node on page
                       load would be a denial-of-service on your own fleet. -->
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
                      disabled={!!updatingNodes[node.id]}
                      onclick={() => handleUpdate(node.id)}
                    >
                      {updatingNodes[node.id] ? "Updating…" : "Update"}
                    </Button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

<!-- New runtime provisioning dialog -->
<NewRuntimeDialog
  open={showNewRuntimeDialog}
  {providers}
  {manifests}
  onClose={() => (showNewRuntimeDialog = false)}
  onCreated={handleRuntimeCreated}
/>
