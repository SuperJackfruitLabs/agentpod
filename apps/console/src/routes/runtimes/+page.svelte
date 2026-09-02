<script lang="ts">
  /**
   * Runtimes — the containers this hub has provisioned.
   *
   * The page used to be a generic data table of coloured word-badges: eight
   * substrate statuses rendered as eight differently-tinted pills, with the one
   * thing an operator actually needs — *why* a runtime is in that status —
   * present but buried under the badge's own styling. It is a plain table now,
   * in the same shape as the muster's nodes table, with the reason as prose
   * under the state.
   *
   * The status word is the RUNTIME's own, not the generic state label. Colour
   * comes from `runtimeState` so a stopping runtime is the same in-flight blue
   * as a starting one — but calling it "Starting" would be a lie, and a
   * `stopping` runtime read as started is exactly the class of lie the
   * statusReason work existed to end. Same rule `nodeState` follows for a
   * machine that is offline rather than "errored".
   */
  import { onMount } from "svelte";
  import {
    listRuntimes,
    destroyRuntime,
    startRuntime,
    stopRuntime,
    listRuntimeProviders,
    type DriverManifest,
  } from "$lib/api/client";
  import type { ProvisionedRuntime } from "@agentpod/contract";
  import PageHeader from "$lib/components/page-header.svelte";
  import StateDot from "$lib/components/shell/StateDot.svelte";
  import { runtimeState, type StateInfo } from "$lib/fleet/state";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Empty } from "$lib/components/ui/empty";
  import TypeToConfirmDialog from "$lib/components/ui/TypeToConfirmDialog.svelte";
  import { relativeTime } from "$lib/utils/relative-time";
  import NewRuntimeDialog from "$lib/components/fleet/NewRuntimeDialog.svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import ContainerIcon from "@lucide/svelte/icons/container";
  import { toast } from "svelte-sonner";

  // ── State ───────────────────────────────────────────────────────────────────
  let runtimes = $state<ProvisionedRuntime[]>([]);
  let providers = $state<string[]>(["docker", "cloudflare"]);
  let manifests = $state<DriverManifest[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let showNewRuntimeDialog = $state(false);

  /** Runtime targeted for destruction; drives the type-to-confirm dialog. */
  let destroyTarget = $state<ProvisionedRuntime | null>(null);
  let isDestroying = $state(false);

  /** Per-runtime in-flight flag for start/stop to disable buttons. */
  let actionInFlight = $state<Record<string, boolean>>({});

  // ── The eight words a runtime can be in ─────────────────────────────────────

  /**
   * The runtime's own vocabulary, sentence-cased.
   *
   * Eight statuses collapse to six states for COLOUR; they must not collapse
   * for the WORD. `stopping` and `starting` share a token because both are an
   * ask in flight, and `stopped` and `destroyed` share one because both are
   * off — but a destroyed runtime that read "Stopped" would invite a Start
   * that can never work.
   */
  const RUNTIME_LABEL: Record<string, string> = {
    provisioning: "Provisioning",
    starting: "Starting",
    online: "Online",
    stopping: "Stopping",
    stopped: "Stopped",
    asleep: "Asleep",
    error: "Error",
    destroyed: "Destroyed",
  };

  function stateOf(status: string): StateInfo {
    return { ...runtimeState(status), label: RUNTIME_LABEL[status] ?? status };
  }

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
      if (res.manifests) manifests = res.manifests;
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
</script>

<svelte:head>
  <title>Runtimes · AgentPod</title>
</svelte:head>

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
<div class="container mx-auto max-w-7xl px-4 py-6 sm:px-6">
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
      class="flex items-start justify-between gap-3 rounded-lg border border-status-error/50 bg-status-error/5 p-4"
      role="alert"
    >
      <p class="text-sm text-status-error">{error}</p>
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
    <!-- Seven columns do not fit a phone; they scroll in here rather than
         dragging the document sideways. -->
    <div data-testid="runtimes-table-scroller" class="overflow-x-auto rounded-lg border border-border">
      <table class="w-full min-w-[880px] text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" class="px-3 py-2 font-medium">Runtime</th>
            <th scope="col" class="px-3 py-2 font-medium">Provider</th>
            <th scope="col" class="px-3 py-2 font-medium">Isolation</th>
            <th scope="col" class="px-3 py-2 font-medium">Node</th>
            <th scope="col" class="px-3 py-2 font-medium">Status</th>
            <th scope="col" class="px-3 py-2 font-medium">Created</th>
            <!--
              `relative` is load-bearing: an sr-only span is position:absolute,
              and with no positioned ancestor its containing block is the
              initial one — so it escapes the overflow-x-auto above and adds to
              the DOCUMENT's scroll width. Measured at 414px on the muster.
            -->
            <th scope="col" class="relative px-3 py-2 font-medium">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {#each runtimes as rt (rt.id)}
            {@const state = stateOf(rt.status)}
            <tr
              data-testid="runtime-row"
              class="relative border-b border-border/50 align-top last:border-b-0"
            >
              <!-- Capped and truncating: a runtime name is free text, and an
                   uncapped one eats the rest of the table. -->
              <td class="max-w-[220px] px-3 py-3">
                <span class="block truncate font-mono font-medium" title={rt.name}>{rt.name}</span>
                {#if rt.harness && rt.harness !== "none"}
                  <span class="block truncate font-mono text-xs text-muted-foreground">
                    {rt.harness} · {rt.resourceTier}
                  </span>
                {:else}
                  <span class="block truncate font-mono text-xs text-muted-foreground">
                    {rt.resourceTier}
                  </span>
                {/if}
              </td>

              <td class="px-3 py-3 font-mono text-xs text-muted-foreground">{rt.provider}</td>

              <td class="px-3 py-3 font-mono text-xs text-muted-foreground">
                <!-- The runtime the provider REPORTED, not the one requested —
                     blank when not recorded rather than defaulting to "runc",
                     which would be a guess presented as a fact. -->
                {rt.runtime ?? ""}
              </td>

              <td class="max-w-[140px] px-3 py-3">
                {#if rt.nodeId}
                  <a
                    href="/nodes/{rt.nodeId}"
                    title={rt.nodeId}
                    class="block truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  >
                    {rt.nodeId.slice(0, 8)}
                  </a>
                {:else}
                  <span class="text-xs text-muted-foreground">—</span>
                {/if}
              </td>

              <td class="px-3 py-3">
                <div class="flex flex-col items-start gap-1" data-testid="status-badge">
                  <StateDot {state} withLabel size="sm" />
                  <!-- Why, when the status alone doesn't say. An operator who
                       sees only "Error" restarts things; one who reads "no node
                       enrolled within 2m of the start request" goes and looks
                       at the container instead. Wrapped, not truncated: the
                       sentence is the whole value of the cell. -->
                  {#if rt.statusReason}
                    <span
                      class="max-w-[22rem] text-xs leading-snug break-words text-muted-foreground"
                      title={rt.statusReason}
                      data-testid="status-reason"
                    >
                      {rt.statusReason}
                    </span>
                  {/if}
                </div>
              </td>

              <td class="px-3 py-3 font-mono text-xs whitespace-nowrap text-muted-foreground">
                {relativeTime(rt.createdAt)}
              </td>

              <td class="px-3 py-3">
                <div class="flex items-center justify-end gap-1.5">
                  <!-- Start: a runtime an operator stopped, or one that failed -->
                  {#if rt.status === "stopped" || rt.status === "error"}
                    <Button
                      variant="outline"
                      size="sm"
                      class="h-7 px-2 text-xs"
                      disabled={!!actionInFlight[rt.id]}
                      onclick={() => handleStart(rt)}
                      data-testid="start-btn"
                    >
                      {actionInFlight[rt.id] ? "Starting…" : "Start"}
                    </Button>
                  {/if}

                  <!-- Wake: the substrate idled this one out. Distinct from
                       Start on purpose — the label should match what happened. -->
                  {#if rt.status === "asleep"}
                    <Button
                      variant="outline"
                      size="sm"
                      class="h-7 px-2 text-xs"
                      disabled={!!actionInFlight[rt.id]}
                      onclick={() => handleWake(rt)}
                      data-testid="wake-btn"
                    >
                      {actionInFlight[rt.id] ? "Waking…" : "Wake"}
                    </Button>
                  {/if}

                  <!-- Stop: only something that is up can be stopped -->
                  {#if rt.status === "online"}
                    <Button
                      variant="outline"
                      size="sm"
                      class="h-7 px-2 text-xs"
                      disabled={!!actionInFlight[rt.id]}
                      onclick={() => handleStop(rt)}
                      data-testid="stop-btn"
                    >
                      {actionInFlight[rt.id] ? "Stopping…" : "Stop"}
                    </Button>
                  {/if}

                  <!-- Destroy: hidden during provisioning or when already gone -->
                  {#if rt.status !== "provisioning" && rt.status !== "destroyed"}
                    <Button
                      variant="destructive"
                      size="sm"
                      class="h-7 px-2 text-xs"
                      onclick={() => (destroyTarget = rt)}
                      data-testid="destroy-btn"
                    >
                      Destroy
                    </Button>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<!-- ── New runtime dialog — reuses the same dialog/flow from NodesOverview ── -->
<NewRuntimeDialog
  open={showNewRuntimeDialog}
  {providers}
  {manifests}
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
