<script lang="ts">
  import "../app.css";
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { connection, initConnection, startReachabilityProbe } from "$lib/stores/connection.svelte";
  import { auth, initAuth } from "$lib/stores/auth.svelte";
  import { themeStore } from "$lib/themes/store.svelte";
  import { commandPalette } from "$lib/stores/command-palette.svelte";
  import { Toaster } from "$lib/components/ui/sonner";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import AppShell from "$lib/components/shell/AppShell.svelte";
  import { contextRailSlot } from "$lib/stores/context-rail.svelte";
  import CommandPalette from "$lib/components/command-palette.svelte";
  import { Spinner } from "$lib/components/ui/spinner";

  let { children } = $props();
  let isInitializing = $state(true);

  // Reactive current path (tracks SvelteKit client navigations — using
  // window.location.pathname imperatively goes stale across goto()).
  let currentPath = $derived(page.url.pathname);

  // Public routes that don't require authentication (no AppShell/BottomNav)
  const publicRoutes = ["/login"];

  // Derived: check if current route is public
  let isPublicRoute = $derived(publicRoutes.some(route => currentPath.startsWith(route)));

  // Derived: should we show the loading spinner?
  // Only show loading during initial app startup
  // Don't show loading during redirects (e.g., after logout) - just let the redirect happen
  let shouldShowLoading = $derived(isInitializing);

  // Derived: should we show the AppShell with bottom navigation?
  // Hide on public routes (login) and show on all authenticated routes
  let showAppShell = $derived(!isPublicRoute && !shouldShowLoading);

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      commandPalette.toggle();
    }
  }

  let stopReachabilityProbe: (() => void) | undefined;

  onMount(async () => {
    themeStore.initialize();

    await initConnection(); // must run before initAuth — sets the auth client base URL
    await initAuth();
    isInitializing = false;

    // Keep connection.reachable honest for the whole session (shell banner).
    stopReachabilityProbe = startReachabilityProbe();

    window.addEventListener("keydown", handleGlobalKeydown);
  });

  onDestroy(() => {
    stopReachabilityProbe?.();
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", handleGlobalKeydown);
    }
  });

  // Auth guard — redirect to login if we are not, or cannot be, authenticated.
  //
  // The second half is the point. `initAuth` returns early without setting
  // `isInitialized` when there is no auth client, and there is no auth client
  // exactly when `initConnection` could not reach a hub. So a visitor whose
  // hub is unreachable — or who has never configured one — used to fall
  // through this guard entirely and get the full shell, signed out, with
  // every pane reporting a failure. /login is also the connect-to-hub screen,
  // which is precisely where that person needs to be.
  $effect(() => {
    if (isInitializing || isPublicRoute) return;

    const definitelyNotAuthenticated = auth.isInitialized
      ? !auth.isAuthenticated
      : !connection.isConnected;

    if (definitelyNotAuthenticated) {
      goto("/login");
    }
  });
</script>

<!-- Tooltip Provider - required for all Tooltip components -->
<Tooltip.Provider>
  <!-- Toast notifications - positioned to avoid bottom nav on mobile -->
  <Toaster richColors position="bottom-right" />

  <div class="min-h-screen bg-background text-foreground">
    {#if shouldShowLoading}
      <div class="flex min-h-screen items-center justify-center bg-background">
        <div class="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p class="text-sm text-muted-foreground">Connecting…</p>
        </div>
      </div>
    {:else if showAppShell}
      <!-- Authenticated routes: wrap in AppShell with bottom navigation.
           The third column belongs to the route, which cannot pass a prop up
           to its own layout — it registers a snippet instead (see
           $lib/stores/context-rail). No registration, no column. -->
      <AppShell contextRail={contextRailSlot.snippet ?? undefined}>
        {@render children()}
      </AppShell>
    {:else}
      <!-- Public routes (login): render without AppShell -->
      {@render children()}
    {/if}
  </div>

  <CommandPalette />
</Tooltip.Provider>
