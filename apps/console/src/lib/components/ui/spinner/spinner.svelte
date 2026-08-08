<script lang="ts">
  import { cn } from "$lib/utils";

  let {
    class: className = undefined,
    size = "md",
  }: { class?: string; size?: "sm" | "md" | "lg" } = $props();

  const sizes = { sm: "size-3.5", md: "size-4.5", lg: "size-6" } as const;
</script>

<svg
  class={cn("animate-spin text-muted-foreground", sizes[size], className)}
  viewBox="0 0 24 24"
  fill="none"
  role="status"
  aria-label="Loading"
>
  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
</svg>
