<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "$lib/stores/auth.svelte";
  import { connection } from "$lib/stores/connection.svelte";
  import { checkIsAdmin } from "$lib/api/admin";
  import { onMount } from "svelte";
  import { Spinner } from "$lib/components/ui/spinner";
  import { Empty } from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import ShieldOffIcon from "@lucide/svelte/icons/shield-off";

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
      error = err.message || "Couldn’t verify admin access.";
    } finally {
      isChecking = false;
    }
  });
</script>

{#if isChecking}
  <!-- Loading state -->
  <main class="flex h-screen flex-col items-center justify-center gap-3">
    <Spinner size="lg" />
    <p class="text-sm text-muted-foreground">Verifying access…</p>
  </main>
{:else if error}
  <!-- Access denied state -->
  <main class="flex h-screen flex-col items-center justify-center px-4">
    <Empty icon={ShieldOffIcon} title="Access denied" description={error} class="max-w-md border-none">
      <Button onclick={() => goto("/")}>Return to home</Button>
    </Empty>
  </main>
{:else}
  <!-- Admin content -->
  {@render children()}
{/if}
