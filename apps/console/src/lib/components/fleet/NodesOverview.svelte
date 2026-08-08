<script lang="ts">
  import { onMount } from "svelte";
  import { startPolling } from "$lib/utils/poll";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { listNodes, createEnrollmentToken, listRuntimes, listRuntimeProviders, updateNode } from "$lib/api/client";
  import { toast } from "svelte-sonner";
  import type { NodeSummary, ProvisionedRuntime } from "@agentpod/contract";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import PageHeader from "$lib/components/page-header.svelte";
  import EnrollmentCommand from "./EnrollmentCommand.svelte";
  import { Metric } from "$lib/components/ui/metric";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Loader2Icon from "@lucide/svelte/icons/loader-2";
  import NewRuntimeDialog from "./NewRuntimeDialog.svelte";
  import ConnectBanner from "./connect-banner.svelte";
  import { statusBadgeClass } from "$lib/utils/status-badge";
  import { chipClass } from "$lib/utils/toggle-chip";
  import { enrollmentCommand } from "$lib/utils/enrollment-command";
  import { cn } from "$lib/utils";

  let nodes = $state<NodeSummary[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let lastToken = $state<string | null>(null);
  let isMinting = $state(false);
  let mintError = $state<string | null>(null);

  // Runtime provisioning state
  let runtimes = $state<ProvisionedRuntime[]>([]);
  let providers = $state<string[]>(["docker", "cloudflare"]);
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
      const [nodesResult, runtimesResult] = await Promise.allSettled([
        listNodes(),
        listRuntimes(),
      ]);
      if (nodesResult.status === "fulfilled") {
        nodes = nodesResult.value;
        error = null;
      } else if (!background) {
        // Background refreshes keep the last good data on screen; the shell's
        // hub-unreachable banner carries the staleness signal.
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
      if (result.ok) {
        // Keep "updating…" state — the node will blip offline→online on the new
        // version and the next nodes refresh will clear updateAvailable.
      } else {
        delete updatingNodes[id];
        toast.error("Update failed", { description: result.error ?? "Unknown error" });
      }
    } catch (e) {
      delete updatingNodes[id];
      toast.error("Update failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  // ── Copy-to-clipboard for enrollment command ───────────────────────────────
  let copied = $state(false);
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;

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
      {#if mintError}<p class="text-xs text-destructive">{mintError}</p>{/if}
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

  <!-- Loading state -->
  {#if isLoading}
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-36 rounded-lg" />
      {/each}
    </div>

  <!-- Error state -->
  {:else if error}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <p class="text-sm text-destructive">{error}</p>
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

  <!-- Node cards + provisioning cards grid -->
  {:else}
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <!-- Provisioning cards (runtimes that are still spinning up) -->
      {#each provisioningRuntimes as rt (rt.id)}
        <div class="h-full rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-1">
          <div class="flex items-start justify-between gap-2">
            <p class="text-sm font-medium leading-tight truncate">
              {rt.name}
            </p>
            <Badge variant="secondary" class="shrink-0 gap-1.5">
              <Loader2Icon class="h-3 w-3 animate-spin" />
              provisioning
            </Badge>
          </div>
          <p class="text-sm text-muted-foreground">
            {rt.provider} · {rt.resourceTier}
          </p>
          {#if rt.harness && rt.harness !== "none"}
            <Badge variant="outline" class="text-xs border-primary/40 text-primary">
              {rt.harness}
            </Badge>
          {/if}
        </div>
      {/each}

      <!-- Online / offline node cards -->
      {#each nodes as node (node.id)}
        <a
          href="/nodes/{node.id}"
          class="block group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
        >
          <div class="h-full rounded-lg border bg-card p-4 space-y-1 transition-colors group-hover:border-primary/50">
            <div class="flex items-start justify-between gap-2">
              <p class="text-sm font-medium leading-tight truncate">
                {node.hostname}
              </p>
              <Badge variant="outline" class="shrink-0 {statusBadgeClass(node.status)}">
                {node.status}
              </Badge>
            </div>
            <p class="text-sm text-muted-foreground">
              <Metric>{node.arch}</Metric> · <Metric>{node.cpuCount}</Metric> CPU
            </p>
            <p class="text-xs text-muted-foreground/70">
              {node.os}
            </p>
            <p class="text-xs text-muted-foreground/60">
              <Metric>{node.agentVersion ?? "—"}</Metric>
            </p>
            {#if node.updateAvailable}
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs text-status-degraded">
                  Update available · <Metric>{node.agentVersion} → {node.latestVersion}</Metric>
                </span>
                <button
                  type="button"
                  disabled={!!updatingNodes[node.id]}
                  onclick={(e) => { e.stopPropagation(); e.preventDefault(); handleUpdate(node.id); }}
                  class={cn(
                    chipClass(false),
                    "text-xs hover:border-primary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed",
                  )}
                >
                  {updatingNodes[node.id] ? "Updating…" : "Update"}
                </button>
              </div>
            {/if}
            {#if node.provisioned}
              <Badge variant="outline" class="text-xs border-primary/40 text-primary">
                provisioned · {node.provisioned.provider}
              </Badge>
            {/if}
          </div>
        </a>
      {/each}
    </div>
  {/if}
</div>

<!-- New runtime provisioning dialog -->
<NewRuntimeDialog
  open={showNewRuntimeDialog}
  {providers}
  onClose={() => (showNewRuntimeDialog = false)}
  onCreated={handleRuntimeCreated}
/>
