<script lang="ts">
  import { onMount } from "svelte";
  import { stationHealth, lifecycle } from "$lib/api/client";
  import TypeToConfirmDialog from "$lib/components/ui/TypeToConfirmDialog.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { StationHealth } from "@agentpod/contract";

  interface Props {
    stationId: string;
    canLifecycle?: boolean;
    matrixId?: string | null;
  }

  let { stationId, canLifecycle = false, matrixId = null }: Props = $props();

  let health = $state<StationHealth | null>(null);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  // Lifecycle action state
  let dialogOpen = $state(false);
  let pendingAction = $state<"stop" | "restart" | null>(null);
  let actionInFlight = $state(false);
  let actionError = $state<string | null>(null);

  async function loadHealth() {
    isLoading = true;
    error = null;
    try {
      health = await stationHealth(stationId);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load health";
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    loadHealth();
  });

  function fmt(v: number | null): string {
    return v !== null ? String(v) : "—";
  }

  function fmtStr(v: string | null): string {
    return v ?? "—";
  }

  function fmtBytes(v: number | null): string {
    if (v === null) return "—";
    if (v < 1024) return `${v} B`;
    if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
    return `${(v / 1073741824).toFixed(2)} GB`;
  }

  function fmtUptime(v: number | null): string {
    if (v === null) return "—";
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    const s = v % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // True when the health note indicates the metrics belong to the shared gateway
  // process (composite OpenClaw stations where all subagents share one process).
  let isGateway = $derived(health?.note?.includes("gateway") ?? false);

  const statusColorClass = $derived(
    health?.running ? "text-status-running" : "text-status-stopped",
  );

  async function doLifecycle(action: "start" | "stop" | "restart") {
    actionInFlight = true;
    actionError = null;
    try {
      health = await lifecycle(stationId, action);
    } catch (err) {
      actionError = err instanceof Error ? err.message : "Action failed";
    } finally {
      actionInFlight = false;
    }
  }

  function handleStart() {
    doLifecycle("start");
  }

  function handleStop() {
    pendingAction = "stop";
    dialogOpen = true;
  }

  function handleRestart() {
    pendingAction = "restart";
    dialogOpen = true;
  }

  function handleDialogConfirm() {
    dialogOpen = false;
    const action = pendingAction;
    pendingAction = null;
    if (action) doLifecycle(action);
  }

  function handleDialogCancel() {
    dialogOpen = false;
    pendingAction = null;
  }
</script>

{#if isLoading}
  <div class="p-4 space-y-3">
    <p class="text-sm text-muted-foreground">Loading health data…</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {#each Array(8) as _, i (i)}
        <Skeleton class="h-14 rounded-lg" />
      {/each}
    </div>
  </div>
{:else if error}
  <div class="p-4">
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <p class="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onclick={loadHealth}>Retry</Button>
    </div>
  </div>
{:else if health}
  <div class="p-4 space-y-4">
    <!-- Responsive stat-tile grid: 1 col mobile → 2 cols sm -->
    <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <!-- Status -->
      <div class="rounded-lg border p-3 flex flex-col gap-1">
        <dt class="text-xs text-muted-foreground">Status</dt>
        <dd class="font-mono text-lg {statusColorClass}">
          {health.running ? "Running" : "Stopped"}
        </dd>
      </div>

      <!-- PID -->
      <div class="rounded-lg border p-3 flex flex-col gap-1">
        <dt class="text-xs text-muted-foreground">PID</dt>
        <dd class="font-mono text-lg text-foreground">
          {fmt(health.pid)}{#if isGateway && health.pid !== null}<span class="text-muted-foreground text-xs ml-1">(gateway)</span>{/if}
        </dd>
      </div>

      <!-- CPU -->
      <div class="rounded-lg border p-3 flex flex-col gap-1">
        <dt class="text-xs text-muted-foreground">CPU</dt>
        <dd class="font-mono text-lg text-foreground">
          {health.cpuPct !== null ? `${health.cpuPct}%` : "—"}{#if isGateway && health.cpuPct !== null}<span class="text-muted-foreground text-xs ml-1">(gateway)</span>{/if}
        </dd>
      </div>

      <!-- Memory -->
      <div class="rounded-lg border p-3 flex flex-col gap-1">
        <dt class="text-xs text-muted-foreground">Memory</dt>
        <dd class="font-mono text-lg text-foreground">
          {fmtBytes(health.memBytes)}{#if isGateway && health.memBytes !== null}<span class="text-muted-foreground text-xs ml-1">(gateway)</span>{/if}
        </dd>
      </div>

      <!-- Disk -->
      <div class="rounded-lg border p-3 flex flex-col gap-1">
        <dt class="text-xs text-muted-foreground">Disk</dt>
        <dd class="font-mono text-lg text-foreground">{fmtBytes(health.diskBytes)}</dd>
      </div>

      <!-- Uptime -->
      <div class="rounded-lg border p-3 flex flex-col gap-1">
        <dt class="text-xs text-muted-foreground">Uptime</dt>
        <dd class="font-mono text-lg text-foreground">
          {fmtUptime(health.uptimeSec)}{#if isGateway && health.uptimeSec !== null}<span class="text-muted-foreground text-xs ml-1">(gateway)</span>{/if}
        </dd>
      </div>

      <!-- Last Activity -->
      <div class="rounded-lg border p-3 flex flex-col gap-1">
        <dt class="text-xs text-muted-foreground">Last Activity</dt>
        <dd class="font-mono text-sm text-foreground">{fmtStr(health.lastActivity)}</dd>
      </div>

      <!-- Note -->
      <div class="rounded-lg border p-3 flex flex-col gap-1">
        <dt class="text-xs text-muted-foreground">Note</dt>
        <dd class="font-mono text-sm text-foreground">{fmtStr(health.note)}</dd>
      </div>

      <!-- Matrix ID (conditional) -->
      {#if matrixId}
        <div class="rounded-lg border p-3 flex flex-col gap-1 sm:col-span-2">
          <dt class="text-xs text-muted-foreground">Matrix</dt>
          <dd class="font-mono text-sm">
            <a
              href="https://matrix.to/#/{matrixId}"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary hover:underline break-all"
            >{matrixId}</a>
          </dd>
        </div>
      {/if}
    </dl>

    <!-- Lifecycle controls -->
    {#if canLifecycle}
      <div class="pt-2 border-t flex flex-wrap gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={actionInFlight}
          onclick={handleStart}
        >
          Start
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={actionInFlight}
          onclick={handleStop}
        >
          Stop
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={actionInFlight}
          onclick={handleRestart}
        >
          Restart
        </Button>
      </div>
      {#if actionError}
        <p class="text-sm text-destructive">{actionError}</p>
      {/if}
    {/if}
  </div>

  {#if canLifecycle}
    <TypeToConfirmDialog
      open={dialogOpen}
      title="{pendingAction === 'stop' ? 'Stop' : 'Restart'} station"
      message="This will {pendingAction} the station process. Type the station ID below to confirm."
      confirmPhrase={stationId}
      confirmLabel="Confirm"
      onConfirm={handleDialogConfirm}
      onCancel={handleDialogCancel}
    />
  {/if}
{/if}
