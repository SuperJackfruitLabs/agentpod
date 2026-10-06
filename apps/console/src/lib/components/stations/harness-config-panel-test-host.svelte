<script lang="ts">
  /**
   * Test host for HarnessConfigPanel's `active` prop (same pattern as
   * page-test-host.svelte).
   *
   * A test cannot flip `active` with @testing-library/svelte's `rerender`:
   * rerender replaces the whole prop set and re-runs the panel's load effect
   * even when every value is identical (measured — one render plus two
   * identical rerenders calls getStationConfig three times). That noise would
   * hide the very thing the keep-alive tests measure, so the flip comes from a
   * parent's own `$state` instead — which is exactly what a tab switch is.
   */
  import HarnessConfigPanel from "./HarnessConfigPanel.svelte";

  let {
    stationId,
    nodeId,
    stationKey,
  }: { stationId: string; nodeId: string; stationKey?: string } = $props();

  let active = $state(true);
</script>

<button data-testid="toggle-active" onclick={() => (active = !active)}>toggle active</button>
<HarnessConfigPanel {stationId} {nodeId} {stationKey} {active} />
