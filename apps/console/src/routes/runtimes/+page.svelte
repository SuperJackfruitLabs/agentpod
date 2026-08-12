<script lang="ts">
  import { onMount } from "svelte";
  import {
    listRuntimes,
    destroyRuntime,
    startRuntime,
    stopRuntime,
    listRuntimeProviders,
  } from "$lib/api/client";
  import type { ProvisionedRuntime } from "@agentpod/contract";
  import type { ColumnDef } from "@tanstack/table-core";
  import PageHeader from "$lib/components/page-header.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Empty } from "$lib/components/ui/empty";
  import { DataTable, renderSnippet } from "$lib/components/ui/data-table";
  import TypeToConfirmDialog from "$lib/components/ui/TypeToConfirmDialog.svelte";
  import { statusBadgeClass } from "$lib/utils/status-badge";
  import { relativeTime } from "$lib/utils/relative-time";
  import NewRuntimeDialog from "$lib/components/fleet/NewRuntimeDialog.svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import ContainerIcon from "@lucide/svelte/icons/container";
  import { toast } from "svelte-sonner";

  // ── State ───────────────────────────────────────────────────────────────────
  let runtimes = $state<ProvisionedRuntime[]>([]);
  let providers = $state<string[]>(["docker", "cloudflare"]);
  let capabilities = $state<Array<{ provider: string; tiers: string[] }>>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let showNewRuntimeDialog = $state(false);

  /** Runtime targeted for destruction; drives the type-to-confirm dialog. */
  let destroyTarget = $state<ProvisionedRuntime | null>(null);
  let isDestroying = $state(false);

  /** Per-runtime in-flight flag for start/stop to disable buttons. */
  let actionInFlight = $state<Record<string, boolean>>({});

  // ── Data loading ─────────────────────────────────────────────────────────────

  async function loadRuntimes() {
    isLoading = true;
    error = null;
    try {
      runtimes = await listRuntimes();
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn’t load runtimes.";
    } finally {
      isLoading = false;
    }
  }

  onMount(async () => {
    // Fetch enabled providers; fall back to defaults on failure
    try {
      const res = await listRuntimeProviders();
      if (res.providers.length > 0) providers = res.providers;
      if (res.capabilities) capabilities = res.capabilities;
    } catch {
      // keep ["docker", "cloudflare"]
    }
    await loadRuntimes();
  });

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleRuntimeCreated() {
    showNewRuntimeDialog = false;
    isLoading = true;
    await loadRuntimes();
  }

  async function handleDestroyConfirm() {
    if (!destroyTarget) return;
    const id = destroyTarget.id;
    isDestroying = true;
    try {
      await destroyRuntime(id);
      destroyTarget = null;
      isLoading = true;
      await loadRuntimes();
    } catch (e) {
      toast.error("Couldn’t destroy the runtime", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      isDestroying = false;
    }
  }

  async function handleStart(rt: ProvisionedRuntime) {
    actionInFlight[rt.id] = true;
    try {
      await startRuntime(rt.id);
      await loadRuntimes();
    } catch (e) {
      toast.error("Couldn’t start the runtime", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      delete actionInFlight[rt.id];
    }
  }

  /**
   * Wake a runtime the substrate idled out.
   *
   * Reuses the start path deliberately: to the driver a wake IS a start, and a
   * second lifecycle route would be free to drift from it.
   */
  async function handleWake(rt: ProvisionedRuntime) {
    actionInFlight[rt.id] = true;
    try {
      await startRuntime(rt.id);
      await loadRuntimes();
    } catch (e) {
      toast.error("Couldn’t wake the runtime", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      delete actionInFlight[rt.id];
    }
  }

  async function handleStop(rt: ProvisionedRuntime) {
    actionInFlight[rt.id] = true;
    try {
      await stopRuntime(rt.id);
      await loadRuntimes();
    } catch (e) {
      toast.error("Couldn’t stop the runtime", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      delete actionInFlight[rt.id];
    }
  }

  // ── Columns ──────────────────────────────────────────────────────────────────
  // Cell snippets (nameCell, nodeCell, statusCell, createdCell, actionsCell) are
  // declared in the markup below; referencing them here is safe because these
  // arrow functions only run later, when FlexRender invokes them — by then the
  // snippet bindings are already initialized.
  const columns: ColumnDef<ProvisionedRuntime>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: (ctx) => renderSnippet(nameCell, { value: ctx.getValue<string>() }),
    },
    {
      accessorKey: "provider",
      header: "Provider",
    },
    {
      id: "runtime",
      header: "Isolation",
      enableSorting: false,
      // The runtime the provider REPORTED, not the one requested — blank when
      // not recorded rather than defaulting to "runc", which would be a guess
      // presented as a fact.
      accessorFn: (row) => row.runtime ?? "",
      cell: (ctx) => renderSnippet(runtimeCell, { value: ctx.getValue<string>() }),
    },
    {
      id: "node",
      header: "Node",
      enableSorting: false,
      accessorFn: (row) => row.nodeId ?? "",
      cell: (ctx) => renderSnippet(nodeCell, { value: ctx.getValue<string>() }),
    },
    {
      accessorKey: "status",
      header: "Status",
      enableSorting: false,
      cell: (ctx) =>
        renderSnippet(statusCell, {
          value: ctx.getValue<string>(),
          reason: ctx.row.original.statusReason ?? null,
        }),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      cell: (ctx) => renderSnippet(createdCell, { value: ctx.getValue<string>() }),
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: (ctx) => renderSnippet(actionsCell, { rt: ctx.row.original }),
    },
  ];
</script>

<svelte:head>
  <title>Runtimes · AgentPod</title>
</svelte:head>

{#snippet nameCell({ value }: { value: string })}
  <span class="font-mono text-sm font-medium">{value}</span>
{/snippet}

{#snippet runtimeCell({ value }: { value: string })}
  {#if value}
    <Badge variant="outline" class="font-mono text-xs">{value}</Badge>
  {/if}
{/snippet}

{#snippet nodeCell({ value }: { value: string })}
  {#if value}
    <a
      href="/nodes/{value}"
      class="font-mono text-xs text-muted-foreground truncate hover:text-primary transition-colors"
    >
      {value.slice(0, 8)}
    </a>
  {:else}
    <span class="text-muted-foreground/30">—</span>
  {/if}
{/snippet}

{#snippet statusCell({ value, reason }: { value: string; reason: string | null })}
  <div class="flex flex-col items-start gap-1">
    <Badge variant="outline" class={statusBadgeClass(value)} data-testid="status-badge">
      {value}
    </Badge>
    <!-- Why, when the status alone doesn't say. An operator who sees only
         "error" restarts things; one who reads "no node enrolled within 2m of
         the start request" goes and looks at the container instead. -->
    {#if reason}
      <span
        class="max-w-[22rem] text-xs leading-snug text-muted-foreground"
        title={reason}
        data-testid="status-reason"
      >
        {reason}
      </span>
    {/if}
  </div>
{/snippet}

{#snippet createdCell({ value }: { value: string })}
  <span class="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(value)}</span>
{/snippet}

{#snippet actionsCell({ rt }: { rt: ProvisionedRuntime })}
  <div class="flex items-center gap-1.5">
    <!-- Start: shown when runtime is stopped or in error -->
    {#if rt.status === "stopped" || rt.status === "error"}
      <button
        type="button"
        disabled={!!actionInFlight[rt.id]}
        onclick={() => handleStart(rt)}
        class="rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors border-status-running/50 text-status-running hover:bg-status-running/10 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="start-btn"
      >
        {actionInFlight[rt.id] ? "Starting…" : "Start"}
      </button>
    {/if}

    <!-- Wake: shown when the substrate idled the runtime out. Distinct from
         Start, which is for a runtime an operator stopped — the label should
         match what actually happened. -->
    {#if rt.status === "asleep"}
      <button
        type="button"
        disabled={!!actionInFlight[rt.id]}
        onclick={() => handleWake(rt)}
        class="rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors border-status-running/50 text-status-running hover:bg-status-running/10 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="wake-btn"
      >
        {actionInFlight[rt.id] ? "Waking…" : "Wake"}
      </button>
    {/if}

    <!-- Stop: shown when runtime is online -->
    {#if rt.status === "online"}
      <button
        type="button"
        disabled={!!actionInFlight[rt.id]}
        onclick={() => handleStop(rt)}
        class="rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="stop-btn"
      >
        {actionInFlight[rt.id] ? "Stopping…" : "Stop"}
      </button>
    {/if}

    <!-- Destroy: hidden during provisioning or when already destroyed -->
    {#if rt.status !== "provisioning" && rt.status !== "destroyed"}
      <button
        type="button"
        onclick={() => (destroyTarget = rt)}
        class="rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors border-status-error/50 text-status-error hover:bg-status-error/10"
        data-testid="destroy-btn"
      >
        Destroy
      </button>
    {/if}
  </div>
{/snippet}

<!-- ── Page header with "New runtime" CTA ─────────────────────────────────── -->
<PageHeader title="Runtimes" subtitle="Provisioned containers">
  {#snippet actions()}
    <Button onclick={() => (showNewRuntimeDialog = true)} data-testid="new-runtime-btn">
      <PlusIcon class="h-4 w-4 mr-2" />
      New runtime
    </Button>
  {/snippet}
</PageHeader>

<!-- ── Main content ───────────────────────────────────────────────────────── -->
<div class="container mx-auto px-4 sm:px-6 max-w-7xl py-6">
  {#if isLoading}
    <!-- Loading skeletons -->
    <div class="space-y-2">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-12 rounded-sm" />
      {/each}
    </div>

  {:else if error}
    <!-- Error state -->
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <p class="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onclick={loadRuntimes}>Retry</Button>
    </div>

  {:else if runtimes.length === 0}
    <!-- Empty state -->
    <div data-testid="empty-state">
      <Empty
        title="No runtimes yet"
        description="Provision your first runtime to get started"
        icon={ContainerIcon}
      >
        <Button onclick={() => (showNewRuntimeDialog = true)} data-testid="empty-new-runtime-btn">
          <PlusIcon class="h-4 w-4 mr-2" />
          New runtime
        </Button>
      </Empty>
    </div>

  {:else}
    <!-- Runtimes table -->
    <DataTable {columns} data={runtimes} rowTestId="runtime-row" />
  {/if}
</div>

<!-- ── New runtime dialog — reuses the same dialog/flow from NodesOverview ── -->
<NewRuntimeDialog
  open={showNewRuntimeDialog}
  {providers}
  {capabilities}
  onClose={() => (showNewRuntimeDialog = false)}
  onCreated={handleRuntimeCreated}
/>

<!-- ── Destroy confirmation dialog (type-to-confirm) ────────────────────────── -->
<TypeToConfirmDialog
  open={destroyTarget !== null}
  title="Destroy runtime"
  message="This will permanently destroy the runtime. This action can’t be undone."
  confirmPhrase={destroyTarget?.name ?? ""}
  confirmLabel="Destroy"
  onConfirm={handleDestroyConfirm}
  onCancel={() => (destroyTarget = null)}
/>
