<script lang="ts">
  import type { Snippet, Component } from "svelte";
  import { page } from "$app/state";
  import { cn } from "$lib/utils";
  import { BottomNav, BottomNavItem } from "$lib/components/ui/bottom-nav";
  import { auth } from "$lib/stores/auth.svelte";
  import { connection } from "$lib/stores/connection.svelte";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import WifiOff from "@lucide/svelte/icons/wifi-off";
  import Boxes from "@lucide/svelte/icons/boxes";
  import Server from "@lucide/svelte/icons/server";
  import ContainerIcon from "@lucide/svelte/icons/container";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import Settings from "@lucide/svelte/icons/settings";
  import ShieldIcon from "@lucide/svelte/icons/shield";

  interface NavItem {
    href: string;
    label: string;
    icon: Component<{ class?: string }>;
    adminOnly?: boolean;
  }

  interface NavGroup {
    label: string;
    items: NavItem[];
  }

  interface Props {
    children?: Snippet;
    /** Hide bottom navigation (useful for fullscreen views like terminal) */
    hideBottomNav?: boolean;
    /** Number of items requiring attention (shown as badge on Fleet item) */
    attentionCount?: number;
    class?: string;
  }

  let {
    children,
    hideBottomNav = false,
    attentionCount = 0,
    class: className,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  let isAdmin = $derived(auth.user?.role === "admin");

  // Resource-typed nav groups for the desktop sidebar
  const baseNavGroups: NavGroup[] = [
    {
      label: "Fleet",
      items: [
        { href: "/", label: "Overview", icon: LayoutDashboard },
        { href: "/agents", label: "Agents", icon: Boxes },
        { href: "/nodes", label: "Nodes", icon: Server },
        { href: "/runtimes", label: "Runtimes", icon: ContainerIcon },
        { href: "/activity", label: "Activity", icon: ActivityIcon },
      ],
    },
    {
      label: "System",
      items: [
        { href: "/settings", label: "Settings", icon: Settings },
      ],
    },
  ];

  const adminNavItem: NavItem = {
    href: "/admin",
    label: "Admin",
    icon: ShieldIcon,
    adminOnly: true,
  };

  // Reactive nav groups — System group gains Admin when user is admin
  let navGroups = $derived(
    baseNavGroups.map((g) =>
      g.label === "System" && isAdmin
        ? { ...g, items: [...g.items, adminNavItem] }
        : g
    )
  );

  // Flat list for the mobile BottomNav (derived from groups, same reactivity)
  let navItems = $derived(navGroups.flatMap((g) => g.items));

  // ---------------------------------------------------------------------------
  // Active-link helper (mirrors BottomNavItem logic)
  // ---------------------------------------------------------------------------

  function isActive(href: string): boolean {
    const pathname = page.url.pathname;
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }
</script>

<!-- Outer wrapper: flex row — side nav + content column -->
<!--
  h-screen, not min-h-screen: a floor lets the flex column grow with its content,
  so panes that set `overflow-y-auto` never engage and the whole PAGE scrolls
  instead. Capping the shell is what makes inner scroll regions (file tree, file
  preview, logs, terminal) scroll in place.
-->
<div class={cn("h-screen overflow-hidden flex", className)}>

  <!-- =========================================================
       Desktop side nav  (hidden on mobile, visible md+)
       ========================================================= -->
  <aside
    class={cn(
      "hidden md:flex flex-col shrink-0",
      "w-16 lg:w-56 sticky top-0 h-screen",
      "border-r bg-background",
      "z-40",
    )}
    aria-label="Main navigation"
  >
    <!-- Brand / logo -->
    <div class="p-3 lg:px-4 lg:py-4 border-b shrink-0">
      <div class="flex items-center gap-2.5">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Server class="size-4" />
        </div>
        <span class="hidden lg:block truncate text-sm font-semibold tracking-tight">AgentPod</span>
      </div>
    </div>

    <!-- Nav items — grouped with section labels -->
    <nav class="flex-1 p-2 overflow-y-auto">
      {#each navGroups as group (group.label)}
        <!-- Group label — hidden on collapsed (icon-only) sidebar -->
        <p class="hidden lg:block px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground first:pt-1">
          {group.label}
        </p>
        <div class="space-y-0.5 mb-1">
          {#each group.items as item (item.href)}
            {@const active = isActive(item.href)}
            <a
              href={item.href}
              class={cn(
                "flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
            >
              <item.icon class="h-4 w-4 shrink-0" />
              <span class="hidden lg:block truncate" aria-hidden="true">{item.label}</span>
            </a>
          {/each}
        </div>
      {/each}
    </nav>

  </aside>

  <!-- =========================================================
       Content column  (grows, holds main + mobile nav)
       ========================================================= -->
  <div
    class={cn(
      "flex-1 flex flex-col min-w-0",
      // On mobile: pad bottom so content doesn't hide under BottomNav
      !hideBottomNav && "pb-16 md:pb-0",
    )}
  >
    <!-- Hub reachability banner — the shell must never claim a live view of a
         hub that stopped answering (periodic /health probe drives this). -->
    {#if connection.isConnected && !connection.reachable}
      <div
        role="status"
        aria-live="polite"
        data-testid="hub-unreachable-banner"
        class="flex items-center justify-center gap-2 border-b border-status-error/30 bg-status-error/10 px-4 py-1.5 text-xs text-status-error"
      >
        <WifiOff class="h-3.5 w-3.5" aria-hidden="true" />
        <span>Hub unreachable — data may be stale. Retrying…</span>
      </div>
    {/if}

    <!-- Page content -->
    <!--
      min-h-0 lets flex children shrink below their content height so their own
      overflow rules apply; overflow-y-auto keeps ordinary long pages scrolling
      as before, now inside main rather than the document.
    -->
    <main class="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {@render children?.()}
    </main>

    <!-- Mobile bottom navigation (md:hidden is built into <BottomNav>) -->
    {#if !hideBottomNav}
      <BottomNav>
        {#each navItems as item (item.href)}
          <BottomNavItem
            href={item.href}
            icon={item.icon}
            label={item.label}
            badge={item.href === "/" ? attentionCount : 0}
          />
        {/each}
      </BottomNav>
    {/if}
  </div>
</div>
