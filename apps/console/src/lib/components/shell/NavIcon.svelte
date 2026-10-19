<script lang="ts">
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import Users from "@lucide/svelte/icons/users";
  import Server from "@lucide/svelte/icons/server";
  import Box from "@lucide/svelte/icons/box";
  import Activity from "@lucide/svelte/icons/activity";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import Shield from "@lucide/svelte/icons/shield";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import type { SectionId } from "./nav";

  let { id, class: className = "" }: { id: SectionId | "more"; class?: string } = $props();
  const ICONS = {
    fleet: LayoutGrid,
    agents: Users,
    nodes: Server,
    runtimes: Box,
    activity: Activity,
    settings: SlidersHorizontal,
    admin: Shield,
    more: Ellipsis,
  };
  const Icon = $derived(ICONS[id]);
</script>

<Icon class={className} aria-hidden="true" />
