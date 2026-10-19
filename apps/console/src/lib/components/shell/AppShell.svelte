<script lang="ts">
  /**
   * AppShell — the three-column shell: roster, stage, context, under a top
   * bar and the attention lane.
   *
   * This task changes no page. Whatever route is mounted renders in the
   * stage column exactly as it did inside the old shell, which is why the
   * stage keeps its own scrolling <main> instead of letting the document
   * scroll.
   */
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { cn } from "$lib/utils";
  import { deriveAttention } from "$lib/fleet/attention";
  import { fleet, startFleetPoll } from "$lib/stores/fleet.svelte";
  import AttentionLane from "./AttentionLane.svelte";
  import RosterRail from "./RosterRail.svelte";
  import TopBar from "./TopBar.svelte";
  import Navigation from "./Navigation.svelte";
  import PhoneBar from "./PhoneBar.svelte";
  import { appearance } from "$lib/appearance.svelte";

  interface Props {
    children?: Snippet;
    /** Supplied per-route; the column does not exist without it. */
    contextRail?: Snippet;
  }

  let { children, contextRail }: Props = $props();

  /**
   * Below 900px there is one column, and roster and stage are two views of
   * it. Above it this state is inert — both columns are on screen.
   */
  let view = $state<"roster" | "stage">("stage");

  const items = $derived(
    deriveAttention({
      agents: fleet.agents,
      nodes: fleet.nodes,
      runtimes: fleet.runtimes,
      stations: fleet.stations,
      principals: fleet.principals,
    }),
  );

  // One poll for the whole console: the shell holds a reference for as long
  // as it is mounted, and the roster/lane/muster share it rather than each
  // opening their own. startFleetPoll returns its stop fn, which onMount
  // runs on destroy.
  onMount(() => startFleetPoll());
</script>

<!--
  grid-cols-[minmax(0,1fr)] is not decoration. Without it the lane's
  horizontally scrolling item list sets this grid's implicit column to its own
  max-content width (1903px at a 1500px viewport, measured in the prototype),
  the shell overflows the viewport, and the context rail lands off screen.
  h-screen, not min-h-screen, for the same reason the old shell used it: a
  capped shell is what makes inner panes (file tree, logs, terminal) scroll in
  place instead of scrolling the document.
-->
<!--
  The head is one grid row: the top bar and the navigation. In Daylight it carries the sky (the
  sun-aware gradient, phase from the appearance store). In Studio shell.css turns it into
  display:contents so the navigation becomes the ink rail down the left of every row.
-->
<div
  data-testid="app-shell"
  class="ap-shell grid h-screen grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground"
>
  <div
    data-testid="shell-head"
    class={cn("ap-head", appearance.value.vibe === "daylight" && "vk-sky")}
    data-phase={appearance.phase}
  >
    {#if appearance.value.vibe === "daylight"}<div class="vk-sky__sun" aria-hidden="true"></div>{/if}
    <TopBar onToggleRoster={() => (view = view === "roster" ? "stage" : "roster")} />
    <div class="ap-head__nav phone:hidden"><Navigation /></div>
  </div>

  <AttentionLane {items} />

  <!-- min-w-0 on every child: the same overflow failure, one level down. -->
  <div
    data-testid="shell-columns"
    class={cn(
      "ap-cols grid min-h-0 grid-cols-[minmax(0,1fr)] min-[901px]:grid-cols-[272px_1fr]",
      contextRail && "min-[1241px]:grid-cols-[272px_1fr_320px]",
    )}
  >
    <!--
      Shown/hidden with the SAME min-[901px] the columns switch on: Tailwind's
      a max-[N] variant compiles to an exclusive `not all and (min-width: N)`, which is
      exclusive, so pairing it with min-[901px] leaves exactly 900px in a
      one-column grid with the roster still in it, stacked above the stage.
      The display class is picked by the ternary rather than layered, because
      `hidden` and `flex` both set `display` and neither wins by class order.
      overflow-hidden here, not overflow-y-auto: the rail scrolls its own row
      list so its filter header and "Where they run" footer stay put, and so
      its group headers have a scroll container to stick to.
    -->
    <div
      data-testid="roster-rail"
      class={cn(
        "ap-roster min-h-0 min-w-0 flex-col overflow-hidden",
        view === "stage" ? "hidden min-[901px]:flex" : "flex",
      )}
    >
      <RosterRail />
    </div>

    <div
      data-testid="stage"
      class={cn(
        "ap-stage min-h-0 min-w-0 flex-col overflow-hidden",
        view === "roster" ? "hidden min-[901px]:flex" : "flex",
      )}
    >
      <!-- The old shell's main, unchanged: existing pages rely on it for
           their scrolling, and this task must not change a page. -->
      <main data-testid="stage-main" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {@render children?.()}
      </main>
    </div>

    {#if contextRail}
      <aside
        data-testid="context-rail"
        class="ap-context hidden min-w-0 overflow-y-auto min-[1241px]:block"
      >
        {@render contextRail()}
      </aside>
    {/if}
  </div>

  <!-- Under 900px the navigation is this bar (Fleet, Agents, Activity, More). -->
  <div data-testid="phone-slot" class="ap-phone min-[901px]:hidden"><PhoneBar /></div>
</div>
