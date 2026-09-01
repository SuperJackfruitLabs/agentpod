<script lang="ts">
  /**
   * The command palette — the fleet's verbs, not a second copy of its
   * navigation.
   *
   * It used to list the four resource pages and every node, which is what the
   * roster rail and the top bar already do better. What has no other keyboard
   * route is: message a named agent, and run a fleet-wide action. So that is
   * what it holds now.
   *
   * Everything it shows comes from the shared `fleet` store rather than a
   * fetch of its own — the shell already holds the one poll for the whole
   * console, and a palette that fetched on open would put a spinner in front
   * of an operator who typed ⌘K precisely because they were in a hurry.
   */
  import * as Command from "$lib/components/ui/command";
  import { commandPalette } from "$lib/stores/command-palette.svelte";
  import { fleet } from "$lib/stores/fleet.svelte";
  import { auth } from "$lib/stores/auth.svelte";
  import { nodePosture, updateAllNodes } from "$lib/api/client";
  import { stationState } from "$lib/fleet/state";
  import { goto } from "$app/navigation";
  import { toast } from "svelte-sonner";
  import type { FleetAgent, NodeSummary } from "@agentpod/contract";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";
  import ArrowUpCircleIcon from "@lucide/svelte/icons/arrow-up-circle";
  import PlusCircleIcon from "@lucide/svelte/icons/plus-circle";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import ScanLineIcon from "@lucide/svelte/icons/scan-line";
  import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
  import BanIcon from "@lucide/svelte/icons/ban";

  /** Authority is admin-only: never offer an action the hub would refuse. */
  const isAdmin = $derived(auth.user?.role === "admin");

  const nodesBehind = $derived(fleet.nodes.filter((n: NodeSummary) => n.updateAvailable));

  /**
   * Nodes a posture scan can actually be asked of. There is no fleet-wide
   * posture endpoint — the hub scans one machine — so this is one entry per
   * machine rather than a single verb that would have to pick one.
   *
   * Offline nodes are out (nothing to ask), and so are nodes that positively
   * report no `posture` capability, which the hub answers 403 for. A node
   * that reports `capabilities: null` is an OLDER node, not a node without
   * the capability, so it is still offered — the hub decides, not a guess
   * made from a missing field.
   */
  const scannableNodes = $derived(
    fleet.nodes.filter(
      (n: NodeSummary) =>
        n.status === "online" && (n.capabilities == null || n.capabilities.includes("posture")),
    ),
  );

  function run(fn: () => void | Promise<void>) {
    void fn();
    commandPalette.close();
  }

  function stationHref(agent: FleetAgent): string {
    return `/nodes/${agent.nodeId}/stations/${agent.stationId}`;
  }

  /**
   * Roll the fleet, reporting what the hub says actually happened rather than
   * "sent" — the same handling as the button on /nodes, because a rollout
   * that claims success while machines stay on the old binary is the defect
   * that route's envelope exists to prevent.
   */
  async function rollFleet() {
    try {
      const result = await updateAllNodes();
      const { updated = 0, failed = 0, skipped = 0 } = result.summary ?? {};
      if (failed > 0) {
        toast.error(`${failed} node${failed === 1 ? "" : "s"} didn’t update`, {
          description: `${updated} updated, ${skipped} skipped.`,
        });
      } else {
        toast.success(`Updating ${updated} node${updated === 1 ? "" : "s"}`, {
          description: "Each will blip offline and come back on the new version.",
        });
      }
    } catch (e) {
      toast.error("Couldn’t roll out the update", {
        description: e instanceof Error ? e.message : "The hub didn’t respond.",
      });
    }
  }

  /**
   * The scan runs here and reports its grade; the findings themselves live on
   * the node's page, which is where the toast points. Grading in a toast and
   * nowhere else would be a report nobody can act on.
   */
  async function scan(node: NodeSummary) {
    try {
      const report = await nodePosture(node.id);
      const failures = report.findings.filter((f) => f.status === "fail").length;
      toast.success(`${node.name} scores ${report.grade}`, {
        description:
          failures === 0
            ? "Nothing failed. Open the node for the full report."
            : `${failures} failing check${failures === 1 ? "" : "s"}. Open the node for the detail.`,
      });
    } catch (e) {
      toast.error(`Couldn’t scan ${node.name}`, {
        description: e instanceof Error ? e.message : "The hub didn’t respond.",
      });
    }
  }

  function handleOpenChange(v: boolean) {
    if (v) commandPalette.open();
    else commandPalette.close();
  }
</script>

<Command.Dialog
  open={commandPalette.isOpen}
  onOpenChange={handleOpenChange}
  title="Command palette"
  description="Search agents and fleet verbs…"
>
  <Command.Input placeholder="Search agents and fleet verbs…" />
  <Command.List>
    <Command.Empty>No results found.</Command.Empty>

    <Command.Group heading="Go to">
      {#each fleet.agents as agent (agent.stationId)}
        {@const state = stationState(agent.status)}
        <!--
          `value` is set explicitly rather than left to the item's text: an
          operator types the handle, the node or the harness, and matching on
          rendered prose ("Message") would score every agent alike.
        -->
        <Command.Item
          data-testid="palette-agent"
          value={`${agent.agentName} ${agent.nodeName} ${agent.harness}`}
          onSelect={() => run(() => goto(stationHref(agent)))}
        >
          <MessageSquareIcon class="mr-2 size-4" />
          <span class="truncate">Message <span class="font-mono">{agent.agentName}</span></span>
          <Command.Shortcut>{agent.nodeName} · {state.label}</Command.Shortcut>
        </Command.Item>
      {/each}
    </Command.Group>

    <Command.Separator />

    <Command.Group heading="Fleet">
      {#if nodesBehind.length > 0}
        <!-- Only when there is something to update: an entry that does
             nothing is an entry that teaches you to ignore the palette. -->
        <Command.Item
          data-testid="palette-update-all"
          value="update every node agent rollout"
          onSelect={() => run(rollFleet)}
        >
          <ArrowUpCircleIcon class="mr-2 size-4" />
          Update every node agent
          <Command.Shortcut>{nodesBehind.length} behind</Command.Shortcut>
        </Command.Item>
      {/if}
      <Command.Item
        data-testid="palette-enrollment-token"
        value="create an enrolment enrollment token node"
        onSelect={() => run(() => goto("/nodes?action=create-token"))}
      >
        <KeyRoundIcon class="mr-2 size-4" />
        Create an enrolment token
      </Command.Item>
      <Command.Item
        data-testid="palette-new-runtime"
        value="new runtime provision"
        onSelect={() => run(() => goto("/nodes?action=new-runtime"))}
      >
        <PlusCircleIcon class="mr-2 size-4" />
        New runtime
      </Command.Item>
      {#each scannableNodes as node (node.id)}
        <Command.Item
          data-testid="palette-posture"
          value={`posture scan ${node.name}`}
          onSelect={() => run(() => scan(node))}
        >
          <ScanLineIcon class="mr-2 size-4" />
          Run a posture scan
          <Command.Shortcut>{node.name}</Command.Shortcut>
        </Command.Item>
      {/each}
    </Command.Group>

    {#if isAdmin}
      <Command.Separator />
      <Command.Group heading="Authority">
        <!-- Both land on /admin/grants, which is where both controls live.
             They are two entries because they are two verbs an operator
             reaches for by name, not two destinations. -->
        <Command.Item
          data-testid="palette-grants"
          value="edit a grant dispatch reach authority"
          onSelect={() => run(() => goto("/admin/grants"))}
        >
          <ShieldCheckIcon class="mr-2 size-4" />
          Edit a grant
          <Command.Shortcut class="text-status-error">destructive</Command.Shortcut>
        </Command.Item>
        <Command.Item
          data-testid="palette-suspend"
          value="suspend a principal agent"
          onSelect={() => run(() => goto("/admin/grants"))}
        >
          <BanIcon class="mr-2 size-4" />
          Suspend a principal
          <Command.Shortcut class="text-status-error">destructive</Command.Shortcut>
        </Command.Item>
      </Command.Group>
    {/if}
  </Command.List>
</Command.Dialog>
