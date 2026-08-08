<script lang="ts">
  import { page } from "$app/state";
  import type { Component } from "svelte";
  import { cn } from "$lib/utils";

  interface Props {
    href: string;
    label: string;
    icon: Component<{ class?: string }>;
    badge?: number;
    class?: string;
  }

  let { href, label, icon: Icon, badge, class: className }: Props = $props();

  // Check if this nav item is active
  // Root path "/" should only match exactly, other paths use startsWith
  let isActive = $derived(
    href === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(href)
  );
</script>

<a
  {href}
  class={cn(
    // Layout
    "flex flex-col items-center justify-center gap-1 flex-1 min-h-[56px] py-2 px-1 relative",
    // Interaction
    "transition-colors touch-manipulation",
    "hover:bg-accent/50 active:bg-accent",
    // Focus states (accessibility)
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    // Active/inactive states using semantic colors
    isActive ? "text-foreground" : "text-muted-foreground",
    className
  )}
  aria-current={isActive ? "page" : undefined}
>
  <div class="relative">
    <Icon
      class={cn(
        "h-5 w-5 transition-transform",
        isActive && "scale-110"
      )}
    />
    {#if badge && badge > 0}
      <span
        class={cn(
          "absolute -top-1 -right-1 min-w-[16px] h-4 px-1",
          "flex items-center justify-center",
          "text-[10px] font-semibold rounded-full",
          // Using semantic destructive color for attention badge
          "bg-destructive text-destructive-foreground"
        )}
      >
        {badge > 99 ? "99+" : badge}
      </span>
    {/if}
  </div>
  <span
    class={cn(
      "text-[11px] font-medium leading-none transition-colors",
      isActive ? "text-foreground" : "text-muted-foreground"
    )}
  >
    {label}
  </span>

  <!-- Active indicator line -->
  {#if isActive}
    <span class="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-foreground rounded-full"></span>
  {/if}
</a>
