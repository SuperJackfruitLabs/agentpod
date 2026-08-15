<script lang="ts">
  /**
   * AdminTabs.svelte
   *
   * Section switcher for the admin area, shared so a new section appears on
   * every admin page at once. The sidebar keeps a single "Admin" entry on
   * purpose — one more top-level item per admin page would crowd out the fleet,
   * which is what people are actually here for.
   *
   * Anchors rather than `PageHeader`'s tabs: each section is a real URL worth
   * bookmarking and middle-clicking, and the header's tab strip pulls in a
   * tooltip context that only exists inside the app shell.
   */
  import { cn } from "$lib/utils";

  interface Props {
    /** The section this page is. */
    active: "users" | "grants";
  }

  let { active }: Props = $props();

  const sections = [
    { id: "users", label: "Users", href: "/admin/users" },
    { id: "grants", label: "Grants", href: "/admin/grants" },
  ] as const;
</script>

<nav class="flex gap-1 border-b" aria-label="Admin sections">
  {#each sections as section (section.id)}
    <a
      href={section.href}
      aria-current={active === section.id ? "page" : undefined}
      class={cn(
        "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active === section.id
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {section.label}
    </a>
  {/each}
</nav>
