<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";
  import { Label } from "$lib/components/ui/label";

  let {
    label,
    description = undefined,
    error = undefined,
    for: htmlFor = undefined,
    class: className = undefined,
    children,
  }: {
    label: string;
    description?: string;
    error?: string;
    for?: string;
    class?: string;
    children: Snippet;
  } = $props();
</script>

<div class={cn("flex flex-col gap-1.5", className)}>
  <Label for={htmlFor}>{label}</Label>
  {@render children()}
  {#if description && !error}
    <p class="text-xs text-muted-foreground">{description}</p>
  {/if}
  {#if error}
    <p class="text-xs text-status-error" role="alert">{error}</p>
  {/if}
</div>
