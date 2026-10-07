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

  interface Props {
    /** The section this page is. */
    active: "users" | "grants" | "bridge" | "transcription" | "speech";
  }

  let { active }: Props = $props();

  const sections = [
    { id: "users", label: "Users", href: "/admin/users" },
    { id: "grants", label: "Grants", href: "/admin/grants" },
    { id: "bridge", label: "Bridge", href: "/admin/bridge" },
    { id: "transcription", label: "Transcription", href: "/admin/transcription" },
    { id: "speech", label: "Speech", href: "/admin/speech" },
  ] as const;
</script>

<!-- A scroll strip, and min-w-0 so it can be narrower than its tabs: five
     sections are 406px, and at 390 the strip used to widen <main> and pan the
     whole page sideways. -->
<nav
  class="scroll-strip flex min-w-0 gap-1 border-b"
  aria-label="Admin sections"
  use:scrollStrip={active}
>
  {#each sections as section (section.id)}
    <a
      href={section.href}
      aria-current={active === section.id ? "page" : undefined}
      class={cn(
        "-mb-px inline-flex shrink-0 items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors max-[900px]:min-h-11 pointer-coarse:min-h-11",
        active === section.id
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {section.label}
    </a>
  {/each}
</nav>
