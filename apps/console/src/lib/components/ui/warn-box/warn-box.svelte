<script lang="ts">
  /**
   * The one warning box: something a person should know before they act (a plan that
   * needs a restart, a capability that is off on the node). Drawn with the console's local
   * warn tone (`--ap-warn*`, vibekit 0.0.13 has no warning token). Not vibekit's Notice:
   * Notice has no warning tone (its `needs` is the signal colour), and it adds an icon and
   * role="note" these boxes never had.
   */
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  let { class: className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: Snippet } = $props();
</script>

<div data-slot="warn-box" class={cn("rounded-md border border-warn/50 bg-warn-wash p-3 text-sm text-foreground", className)} {...rest}>
  {@render children()}
</div>
