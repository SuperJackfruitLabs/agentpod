<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";

  interface Props {
    children: Snippet;
    class?: string;
  }

  let { children, class: className }: Props = $props();
</script>

<nav
  class={cn(
    // Positioning - fixed to bottom, hidden on tablet+
    "fixed bottom-0 inset-x-0 z-50 md:hidden",
    // Solid flat background using semantic colors
    "bg-background",
    // Border using semantic color
    "border-t border-border",
    // Safe area padding for iOS devices (uses env() CSS function)
    "pb-[env(safe-area-inset-bottom)]",
    className
  )}
  aria-label="Main navigation"
>
  <div class="flex items-stretch justify-around max-w-lg mx-auto">
    {@render children()}
  </div>
</nav>
