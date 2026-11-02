<script lang="ts">
  /**
   * Test host for page.characterization.svelte.test.ts: the page inside the Tooltip.Provider the
   * root layout gives it, beside the context rail it hands the shell, rendered the way the shell
   * renders it (so the rail's props are part of the snapshot).
   */
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { contextRailSlot } from "$lib/stores/context-rail.svelte";
  import StationPage from "./+page.svelte";
</script>

<Tooltip.Provider>
  <StationPage />
  <aside data-testid="test-context-rail">
    {#if contextRailSlot.snippet}{@render contextRailSlot.snippet()}{/if}
  </aside>
</Tooltip.Provider>
