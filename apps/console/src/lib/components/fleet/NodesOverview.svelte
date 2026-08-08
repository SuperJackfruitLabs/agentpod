<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { listNodes, createEnrollmentToken, listRuntimes, listRuntimeProviders, updateNode } from "$lib/api/client";
  import { toast } from "svelte-sonner";
  import type { NodeSummary, ProvisionedRuntime } from "@agentpod/contract";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Loader2Icon from "@lucide/svelte/icons/loader-2";
  import NewRuntimeDialog from "./NewRuntimeDialog.svelte";
  import ConnectBanner from "./connect-banner.svelte";
  import { statusBadgeClass } from "$lib/utils/status-badge";

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

  async function loadData() {
    try {
      const [nodesResult, runtimesResult] = await Promise.allSettled([
        listNodes(),
        listRuntimes(),
      ]);
      if (nodesResult.status === "fulfilled") {
        nodes = nodesResult.value;
      } else {
        error =
          nodesResult.reason instanceof Error
            ? nodesResult.reason.message
            : "Failed to load nodes";
      }
      if (runtimesResult.status === "fulfilled") {
        runtimes = runtimesResult.value;
      }
      // runtimes failing is non-fatal — keep the previous value
    } finally {
      isLoading = false;
    }
  }

  onMount(async () => {
    // Fetch enabled providers; fall back to defaults on failure
    try {
      const res = await listRuntimeProviders();
      if (res.providers.length > 0) providers = res.providers;
    } catch {
      // keep fallback ["docker", "cloudflare"]
    }
    await loadData();
  });

  // ?action=<new-runtime|create-token> handling. This must be a reactive
  // $effect rather than onMount: SvelteKit does not remount this component
  // on same-route navigation, e.g. the command palette navigating from
  // /nodes to /nodes?action=new-runtime while /nodes is already mounted.
  // Reading page.url.searchParams inside $effect re-runs the branch
  // whenever the reactive URL changes, including in place.
  //
  // Loop guard: replaceState below clears the "action" param, which updates
  // the reactive page.url (in real SvelteKit) and re-runs this effect with
  // action=null — a no-op — so it settles after one pass and never loops.
  // The optional chaining also guards test/SSR environments where
  // page.url.searchParams may be absent.
  $effect(() => {
    const action = (page.url as { searchParams?: URLSearchParams } | undefined)?.searchParams?.get("action") ?? null;
    if (!action) return;
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
    const cmd = `curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh | sudo bash -s -- ${resolvedHubUrl()} ${lastToken}`;
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

<section class="space-y-6">
  <!-- Header row -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
    <div>
      <h2 class="text-2xl font-bold tracking-tight">Nodes</h2>
      <p class="text-sm text-muted-foreground font-mono">// connected machines</p>
    </div>
    <div class="flex flex-col items-start sm:items-end gap-2">
      <div class="flex gap-2 flex-wrap justify-end">
        <Button
          onclick={() => (showNewRuntimeDialog = true)}
          variant="outline"
          class="font-mono text-xs uppercase tracking-wider w-full sm:w-auto"
        >
          <PlusIcon class="h-4 w-4 mr-2" />
          New runtime
        </Button>
        <!--
          Show the "Create enrollment token" header button only when nodes are present
          (or while loading). When nodes=0 the ConnectBanner below supplies the same CTA
          to avoid duplicate accessible buttons.
        -->
        {#if isLoading || nodes.length > 0 || provisioningRuntimes.length > 0}
          <Button
            onclick={handleCreateToken}
            disabled={isMinting}
            class="font-mono text-xs uppercase tracking-wider w-full sm:w-auto"
          >
            <PlusIcon class="h-4 w-4 mr-2" />
            {isMinting ? "Creating…" : "Create enrollment token"}
          </Button>
        {/if}
      </div>
      {#if mintError}<p class="text-xs text-destructive">{mintError}</p>{/if}
    </div>
  </div>

  <!-- Enrollment command block (only when nodes/runtimes already exist; in empty state it shows in-place) -->
  {#if lastToken && (nodes.length > 0 || provisioningRuntimes.length > 0)}
    <div class="cyber-card p-4 space-y-2">
      <p class="text-xs font-mono text-muted-foreground">// run this on the target node to connect it</p>
      <div class="flex items-start gap-2">
        <code class="flex-1 block text-sm font-mono break-all text-primary">
          curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh | sudo bash -s -- {resolvedHubUrl()} {lastToken}
        </code>
        <button
          type="button"
          onclick={handleCopyEnrollCmd}
          class="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors
            {copied
              ? 'border-chart-2 text-chart-2 bg-chart-2/10'
              : 'border-primary/40 text-primary/70 hover:border-primary hover:text-primary bg-transparent'}"
          aria-label="Copy enrollment command"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
    </div>
  {/if}

  <!-- Loading state -->
  {#if isLoading}
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-36 rounded-xl" />
      {/each}
    </div>

  <!-- Error state -->
  {:else if error}
    <div class="cyber-card p-4 border-destructive/50">
      <p class="text-sm font-mono text-destructive">{error}</p>
    </div>

  <!-- Empty state: no nodes and no provisioning runtimes → connect banner or in-place token -->
  {:else if nodes.length === 0 && provisioningRuntimes.length === 0}
    <div class="flex flex-col items-center py-8">
      <div class="w-full max-w-2xl">
        {#if lastToken}
          <div class="cyber-card p-6 space-y-3">
            <p class="text-xs font-mono text-muted-foreground">// enrollment token created — run this on the target node to connect it</p>
            <div class="flex items-start gap-2">
              <code class="flex-1 block text-sm font-mono break-all text-primary">
                curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh | sudo bash -s -- {resolvedHubUrl()} {lastToken}
              </code>
              <button
                type="button"
                onclick={handleCopyEnrollCmd}
                class="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors
                  {copied
                    ? 'border-chart-2 text-chart-2 bg-chart-2/10'
                    : 'border-primary/40 text-primary/70 hover:border-primary hover:text-primary bg-transparent'}"
                aria-label="Copy enrollment command"
              >
                {copied ? "copied ✓" : "copy"}
              </button>
            </div>
            <p class="text-xs font-mono text-muted-foreground/60">// the node will appear below once it connects</p>
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
        <Card.Root class="h-full border-primary/30 bg-primary/5">
          <Card.Header>
            <div class="flex items-start justify-between gap-2">
              <Card.Title class="font-mono text-sm leading-tight truncate">
                {rt.name}
              </Card.Title>
              <Badge variant="secondary" class="shrink-0 gap-1.5">
                <Loader2Icon class="h-3 w-3 animate-spin" />
                provisioning
              </Badge>
            </div>
          </Card.Header>
          <Card.Content class="space-y-1">
            <p class="text-sm font-mono text-muted-foreground">
              {rt.provider} · {rt.resourceTier}
            </p>
            {#if rt.harness && rt.harness !== "none"}
              <Badge
                variant="outline"
                class="font-mono text-[10px] border-primary/40 text-primary"
              >
                {rt.harness}
              </Badge>
            {/if}
          </Card.Content>
        </Card.Root>
      {/each}

      <!-- Online / offline node cards -->
      {#each nodes as node (node.id)}
        <a
          href="/nodes/{node.id}"
          class="block group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xl"
        >
          <Card.Root class="h-full transition-colors group-hover:border-primary/50">
            <Card.Header>
              <div class="flex items-start justify-between gap-2">
                <Card.Title class="font-mono text-sm leading-tight truncate">
                  {node.hostname}
                </Card.Title>
                <Badge
                  variant="outline"
                  class="shrink-0 {statusBadgeClass(node.status)}"
                >
                  {node.status}
                </Badge>
              </div>
            </Card.Header>
            <Card.Content class="space-y-1">
              <p class="text-sm font-mono text-muted-foreground">
                {node.arch} · {node.cpuCount} CPU
              </p>
              <p class="text-xs font-mono text-muted-foreground/70">
                {node.os}
              </p>
              <p class="text-xs font-mono text-muted-foreground/60">
                v: {node.agentVersion ?? "unknown"}
              </p>
              {#if node.updateAvailable}
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[10px] font-mono text-yellow-500/90">
                    update: {node.agentVersion} → {node.latestVersion}
                  </span>
                  <button
                    type="button"
                    disabled={!!updatingNodes[node.id]}
                    onclick={(e) => { e.stopPropagation(); e.preventDefault(); handleUpdate(node.id); }}
                    class="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border transition-colors border-primary/50 text-primary hover:border-primary hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    {updatingNodes[node.id] ? "updating…" : "Update"}
                  </button>
                </div>
              {/if}
              {#if node.provisioned}
                <Badge
                  variant="outline"
                  class="font-mono text-[10px] border-primary/40 text-primary"
                >
                  provisioned · {node.provisioned.provider}
                </Badge>
              {/if}
            </Card.Content>
          </Card.Root>
        </a>
      {/each}
    </div>
  {/if}
</section>

<!-- New runtime provisioning dialog -->
<NewRuntimeDialog
  open={showNewRuntimeDialog}
  {providers}
  onClose={() => (showNewRuntimeDialog = false)}
  onCreated={handleRuntimeCreated}
/>
