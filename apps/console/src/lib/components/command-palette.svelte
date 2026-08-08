<script lang="ts">
  import * as Command from "$lib/components/ui/command";
  import { commandPalette } from "$lib/stores/command-palette.svelte";
  import { listNodes } from "$lib/api/client";
  import { goto } from "$app/navigation";
  import ServerIcon from "@lucide/svelte/icons/server";
  import PlusCircleIcon from "@lucide/svelte/icons/plus-circle";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import SettingsIcon from "@lucide/svelte/icons/settings";

  let nodes = $state<{ id: string; hostname: string }[]>([]);

  // Load node list whenever the palette opens, mirroring the old component's
  // on-open fetch (results reset to empty on failure so a bad fetch doesn't
  // leave stale entries around).
  $effect(() => {
    if (commandPalette.isOpen) {
      listNodes()
        .then((fetched) => {
          nodes = fetched.map((n) => ({ id: n.id, hostname: n.hostname }));
        })
        .catch(() => {
          nodes = [];
        });
    }
  });

  function run(fn: () => void) {
    fn();
    commandPalette.close();
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
  description="Search fleet commands, nodes…"
>
  <Command.Input placeholder="Search fleet commands, nodes…" />
  <Command.List>
    <Command.Empty>No results found.</Command.Empty>
    <Command.Group heading="Actions">
      <Command.Item onSelect={() => run(() => goto("/?action=new-runtime"))}>
        <PlusCircleIcon class="mr-2 size-4" />
        New runtime
      </Command.Item>
      <Command.Item onSelect={() => run(() => goto("/?action=create-token"))}>
        <KeyRoundIcon class="mr-2 size-4" />
        Create enrollment token
      </Command.Item>
      <Command.Item onSelect={() => run(() => goto("/"))}>
        <LayoutDashboardIcon class="mr-2 size-4" />
        Fleet
      </Command.Item>
      <Command.Item onSelect={() => run(() => goto("/settings"))}>
        <SettingsIcon class="mr-2 size-4" />
        Settings
      </Command.Item>
    </Command.Group>
    {#if nodes.length > 0}
      <Command.Separator />
      <Command.Group heading="Nodes">
        {#each nodes as node (node.id)}
          <Command.Item onSelect={() => run(() => goto(`/nodes/${node.id}`))}>
            <ServerIcon class="mr-2 size-4" />
            {node.hostname}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
</Command.Dialog>
