<script lang="ts">
  /**
   * Test stub that stands in for a child component and renders the props it was given, so a
   * snapshot of the parent pins exactly what the parent passes down (functions as "[fn]").
   *
   *   vi.mock("$lib/components/stations/HealthPanel.svelte", () => propsStub("HealthPanel"))
   *
   * `propsStub` (props-stub.ts) wraps this component with the stubbed component's name.
   */
  let { __stub, ...rest }: Record<string, unknown> = $props();

  const shown = $derived(
    JSON.stringify(
      Object.fromEntries(
        Object.keys(rest)
          .toSorted()
          .map((k) => [k, typeof rest[k] === "function" ? "[fn]" : (rest[k] ?? null)]),
      ),
    ),
  );
</script>

<div data-stub={String(__stub)}>{shown}</div>
