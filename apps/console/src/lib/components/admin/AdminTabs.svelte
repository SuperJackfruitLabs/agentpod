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
  import { scrollStrip } from "$lib/actions/scroll-strip";
  import { auth } from "$lib/stores/auth.svelte";
  import { adminSections } from "$lib/components/shell/nav";

  interface Props {
    /** The section this page is. */
    active: "users" | "grants" | "bridge" | "transcription" | "speech";
  }

  let { active }: Props = $props();

  // Workspace pages for workspace admins, hub settings for the hub's operator: a tab that only
  // leads to "ask someone else" is not offered.
  const sections = $derived(adminSections({ isWorkspaceAdmin: auth.isWorkspaceAdmin, isHubOperator: auth.isHubOperator }));
</script>

<!-- A scroll strip, and min-w-0 so it can be narrower than its tabs: five
     sections are 406px, and at 390 the strip used to widen <main> and pan the
     whole page sideways. -->
<nav
  class="ap-atabs scroll-strip flex min-w-0 gap-1 border-b"
  aria-label="Admin sections"
  use:scrollStrip={active}
>
  {#each sections as section (section.id)}
    <a
      href={section.href}
      aria-current={active === section.id ? "page" : undefined}
      class={cn(
        "-mb-px inline-flex shrink-0 items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors touch:min-h-11",
        active === section.id
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {section.label}
    </a>
  {/each}
</nav>
