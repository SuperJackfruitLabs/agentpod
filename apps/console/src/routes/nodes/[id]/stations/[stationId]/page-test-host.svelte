<script lang="ts">
  /**
   * Test host for +page.svelte. PageHeader's tab bar wraps each tab in a
   * bits-ui Tooltip, which requires a Tooltip.Provider from an ancestor — in
   * the app that comes from the root +layout, so tests mount the page through
   * this wrapper (same pattern as page-header-test-host.svelte).
   */
  import * as Tooltip from "$lib/components/ui/tooltip";
  import StationPage from "./+page.svelte";
</script>

<Tooltip.Provider>
  <StationPage />
</Tooltip.Provider>
