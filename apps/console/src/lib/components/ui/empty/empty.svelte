<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { cn } from "$lib/utils";

  let {
    icon = undefined,
    title,
    description = undefined,
    class: className = undefined,
    children = undefined,
  }: {
    icon?: Component;
    title: string;
    description?: string;
    class?: string;
    children?: Snippet;
  } = $props();
  const Icon = $derived(icon);
</script>

<div class={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center", className)}>
  {#if Icon}
    <Icon class="size-8 text-muted-foreground" aria-hidden="true" />
  {/if}
  <p class="text-sm font-medium text-foreground">{title}</p>
  {#if description}
    <p class="max-w-sm text-sm text-muted-foreground">{description}</p>
  {/if}
  {#if children}
    <div class="mt-2 flex items-center gap-2">
      {@render children()}
    </div>
  {/if}
</div>
