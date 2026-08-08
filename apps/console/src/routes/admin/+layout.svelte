<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "$lib/stores/auth.svelte";
  import { connection } from "$lib/stores/connection.svelte";
  import { checkIsAdmin } from "$lib/api/admin";
  import { onMount } from "svelte";

  let { children } = $props();
  let isChecking = $state(true);
  let isAdmin = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    // Check if connected and authenticated first
    if (!connection.isConnected) {
      goto("/login");
      return;
    }
    if (!auth.isAuthenticated) {
      goto("/login");
      return;
    }

    // Check admin status
    try {
      isAdmin = await checkIsAdmin();
      if (!isAdmin) {
        error = "You do not have permission to access this area.";
      }
    } catch (e) {
      const err = e as Error;
      error = err.message || "Failed to verify admin status";
    } finally {
      isChecking = false;
    }
  });
</script>

{#if isChecking}
  <!-- Loading state -->
  <div class="noise-overlay"></div>
  <main class="h-screen flex flex-col grid-bg mesh-gradient overflow-hidden items-center justify-center">
    <div class="text-center animate-fade-in-up">
      <div class="relative">
        <div class="w-16 h-16 rounded-full border-2 border-primary/20 mx-auto"></div>
        <div class="absolute inset-0 w-16 h-16 rounded-full border-2 border-transparent border-t-[var(--primary)] mx-auto animate-spin"></div>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-2 h-2 rounded-full bg-primary animate-pulse-dot"></div>
        </div>
      </div>
      <p class="mt-6 text-sm font-mono text-muted-foreground tracking-wider uppercase">
        Verifying access<span class="typing-cursor"></span>
      </p>
    </div>
  </main>
{:else if error}
  <!-- Access denied state -->
  <div class="noise-overlay"></div>
  <main class="h-screen flex flex-col grid-bg mesh-gradient overflow-hidden items-center justify-center">
    <div class="text-center animate-fade-in-up max-w-md px-4">
      <div class="w-16 h-16 rounded-full border-2 border-destructive/30 mx-auto flex items-center justify-center">
        <svg class="w-8 h-8 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m0 0v2m0-2h2m-2 0H8m4-6V4" />
        </svg>
      </div>
      <h1 class="mt-6 text-xl font-mono text-destructive">[access_denied]</h1>
      <p class="mt-2 text-sm font-mono text-muted-foreground">
        {error}
      </p>
      <button
        onclick={() => goto("/")}
        class="mt-6 px-6 py-2 font-mono text-xs uppercase tracking-wider border border-border/50 rounded hover:border-primary hover:text-primary transition-colors"
      >
        Return to Home
      </button>
    </div>
  </main>
{:else}
  <!-- Admin content -->
  {@render children()}
{/if}
