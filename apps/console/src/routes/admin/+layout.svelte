<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth } from "$lib/stores/auth.svelte";
  import { connection } from "$lib/stores/connection.svelte";
  import { getAdminStats } from "$lib/api/admin";
  import { ApiError } from "$lib/api/http-error";
  import { onMount } from "svelte";
  import { Spinner } from "$lib/components/ui/spinner";
  import { Empty } from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import ShieldOffIcon from "@lucide/svelte/icons/shield-off";

  let { children } = $props();
  let isChecking = $state(true);
  let isAdmin = $state(false);
  /** Only a real 403 is a permission verdict. */
  let denied = $state(false);
  /** Anything else that stopped the check (hub unreachable, a 500): retryable. */
  let failure = $state<string | null>(null);

  async function check() {
    isChecking = true;
    denied = false;
    failure = null;
    try {
      // An admin can read the stats; that is the check (it stays with the hub under the plane).
      await getAdminStats();
      isAdmin = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) denied = true;
      else failure = (e as Error).message || "Couldn’t verify admin access.";
    } finally {
      isChecking = false;
    }
  }

  onMount(() => {
    if (!connection.isConnected || !auth.isAuthenticated) {
      goto("/login");
      return;
    }
    void check();
  });
</script>

{#if isChecking}
  <main class="ap-guard" role="status">
    <Spinner size="lg" />
    <p class="text-sm text-muted-foreground">Verifying access…</p>
  </main>
{:else if denied}
  <main class="ap-guard">
    <Empty icon={ShieldOffIcon} title="Access denied" description="You do not have permission to access this area." class="max-w-md border-none">
      <Button onclick={() => goto("/")}>Return to home</Button>
    </Empty>
  </main>
{:else if failure}
  <main class="ap-guard">
    <div class="ap-alert w-full max-w-xl" role="alert">
      <p class="text-sm">{failure}</p>
      <Button variant="outline" size="sm" onclick={check}>Retry</Button>
    </div>
  </main>
{:else if isAdmin}
  {@render children()}
{/if}
