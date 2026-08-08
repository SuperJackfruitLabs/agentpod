<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { cn } from "$lib/utils";

  interface Props {
    harness: string;
    class?: string;
  }

  let { harness, class: className }: Props = $props();
</script>

<Badge variant="outline" class={cn("font-mono text-xs text-primary border-primary/40", className)}>
  {harness}
</Badge>
