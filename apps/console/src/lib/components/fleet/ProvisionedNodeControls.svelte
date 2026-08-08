<script lang="ts">
  import { goto } from "$app/navigation";
  import { destroyRuntime, startRuntime, stopRuntime } from "$lib/api/client";
  import type { NodeSummary } from "@agentpod/contract";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import TypeToConfirmDialog from "$lib/components/ui/TypeToConfirmDialog.svelte";

  interface Props {
    node: NodeSummary;
    onRefresh: () => void;
  }

  let { node, onRefresh }: Props = $props();

  // Derived: provisioned info shorthand
  let provisioned = $derived(node.provisioned ?? null);
  let isDocker = $derived(provisioned?.provider === "docker");

  // Destroy dialog
  let destroyDialogOpen = $state(false);
  let destroyInFlight = $state(false);
  let destroyError = $state<string | null>(null);

  // Stop / Start in-flight
  let stopInFlight = $state(false);
  let startInFlight = $state(false);
  let actionError = $state<string | null>(null);

  async function handleDestroy() {
    if (!provisioned) return;
    destroyInFlight = true;
    destroyError = null;
    try {
      await destroyRuntime(provisioned.runtimeId);
      destroyDialogOpen = false;
      await goto("/");
    } catch (err) {
      destroyDialogOpen = false;
      destroyError = err instanceof Error ? err.message : "Couldn’t destroy the runtime.";
    } finally {
      destroyInFlight = false;
    }
  }

  async function handleStop() {
    if (!provisioned) return;
    stopInFlight = true;
    actionError = null;
    try {
      await stopRuntime(provisioned.runtimeId);
      onRefresh();
    } catch (err) {
      actionError = err instanceof Error ? err.message : "Couldn’t stop the runtime.";
    } finally {
      stopInFlight = false;
    }
  }

  async function handleStart() {
    if (!provisioned) return;
    startInFlight = true;
    actionError = null;
    try {
      await startRuntime(provisioned.runtimeId);
      onRefresh();
    } catch (err) {
      actionError = err instanceof Error ? err.message : "Couldn’t start the runtime.";
    } finally {
      startInFlight = false;
    }
  }
</script>

{#if provisioned}
  <!-- Provisioned badge -->
  <Badge
    variant="outline"
    class="font-mono text-xs border-primary/50 text-primary"
  >
    provisioned · {provisioned.provider}
  </Badge>

  <!-- Controls row -->
  <div class="flex flex-wrap items-center gap-2 mt-2">
    <!-- Destroy (always shown for provisioned nodes) -->
    <Button
      variant="destructive"
      size="sm"
      disabled={destroyInFlight}
      onclick={() => (destroyDialogOpen = true)}
      class="text-xs"
    >
      {destroyInFlight ? "Destroying…" : "Destroy"}
    </Button>

    <!-- Stop / Start (docker only) -->
    {#if isDocker}
      <Button
        variant="outline"
        size="sm"
        disabled={stopInFlight}
        onclick={handleStop}
        class="text-xs"
      >
        {stopInFlight ? "Stopping…" : "Stop"}
      </Button>

      <Button
        variant="outline"
        size="sm"
        disabled={startInFlight}
        onclick={handleStart}
        class="text-xs"
      >
        {startInFlight ? "Starting…" : "Start"}
      </Button>
    {/if}
  </div>

  <!-- Inline errors -->
  {#if destroyError}
    <p class="text-xs text-destructive font-mono mt-1">{destroyError}</p>
  {/if}
  {#if actionError}
    <p class="text-xs text-destructive font-mono mt-1">{actionError}</p>
  {/if}

  <!-- Destroy confirmation dialog -->
  <TypeToConfirmDialog
    open={destroyDialogOpen}
    title="Destroy runtime"
    message="This will permanently destroy the runtime and remove the node from the fleet. This action can’t be undone."
    confirmPhrase={node.hostname}
    confirmLabel="Destroy"
    onConfirm={handleDestroy}
    onCancel={() => {
      destroyDialogOpen = false;
      destroyError = null;
    }}
  />
{/if}
