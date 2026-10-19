<script lang="ts">
  import * as Sheet from "$lib/components/ui/sheet";
  let { side }: { side: "top" | "right" | "bottom" | "left" } = $props();
</script>

<Sheet.Root open>
  <Sheet.Content {side}>
    <Sheet.Title>Sheet</Sheet.Title>
    <p>Body</p>
  </Sheet.Content>
</Sheet.Root>
