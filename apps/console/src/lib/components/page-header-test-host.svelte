<script lang="ts">
  import * as Tooltip from "$lib/components/ui/tooltip";
  import PageHeader from "./page-header.svelte";
  import type { ComponentProps } from "svelte";

  let props: ComponentProps<typeof PageHeader> = $props();
</script>

<Tooltip.Provider>
  <PageHeader {...props} />
</Tooltip.Provider>
