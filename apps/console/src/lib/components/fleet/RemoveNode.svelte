<script lang="ts">
  /**
   * Remove an enrolled node from the fleet. Not for a provisioned runtime's
   * node — that one is destroyed with its runtime (ProvisionedNodeControls).
   */
  import { goto } from "$app/navigation";
  import { removeNode } from "$lib/api/client";
  import { refreshFleet } from "$lib/stores/fleet.svelte";
  import type { NodeSummary } from "@agentpod/contract";
  import { Button } from "$lib/components/ui/button";
  import TypeToConfirmDialog from "$lib/components/ui/TypeToConfirmDialog.svelte";
  import { toast } from "svelte-sonner";

  let { node }: { node: NodeSummary } = $props();

  let open = $state(false);
  let busy = $state(false);
  let problem = $state<string | null>(null);

  const connected = $derived(node.status === "online");
  const message = $derived(
    "This unregisters every station on this node and revokes the node's credential, so the " +
      "machine cannot reconnect. Workspace files and agent identities on the machine are kept, " +
      "and the node-agent keeps running until you uninstall it. " +
      (connected
        ? "The node is connected now: it will be disconnected, and to rejoin it must be re-enrolled with a fresh invite token."
        : "To rejoin, the machine must be re-enrolled with a fresh invite token.")
  );

  async function remove() {
    if (busy) return;
    busy = true;
    problem = null;
    open = false;
    try {
      // Force only for the node the dialog just warned about: the hub's
      // online refusal stays the guard against a node that came back while
      // this page was open showing it offline.
      await removeNode(node.id, { force: connected });
      toast.success(`Removed ${node.name}`);
      void refreshFleet(true);
      await goto("/nodes");
    } catch (e) {
      problem = e instanceof Error ? e.message : "Couldn’t remove the node.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-1">
  <Button
    variant="outline"
    size="sm"
    class="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
    disabled={busy}
    onclick={() => {
      problem = null;
      open = true;
    }}
  >
    {busy ? "Removing…" : "Remove node"}
  </Button>
  {#if problem}
    <p role="alert" class="max-w-prose text-xs text-destructive">{problem}</p>
  {/if}
</div>

<TypeToConfirmDialog
  {open}
  title={`Remove ${node.name} from the fleet?`}
  {message}
  confirmPhrase={node.name}
  confirmLabel="Remove node"
  onConfirm={remove}
  onCancel={() => (open = false)}
/>
