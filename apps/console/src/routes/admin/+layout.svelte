<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { auth } from "$lib/stores/auth.svelte";
  import { connection } from "$lib/stores/connection.svelte";
  import { getAdminStats } from "$lib/api/admin";
  import { ApiError } from "$lib/api/http-error";
  import { adminAudience } from "$lib/components/shell/nav";
  import { ASK_AN_ADMIN, ASK_THE_OPERATOR } from "$lib/workspace-authority";
  import { onMount } from "svelte";
  import { Spinner } from "$lib/components/ui/spinner";
  import { Button } from "$lib/components/ui/button";

  let { children } = $props();

  /**
   * Two audiences share this area. The workspace pages (users, grants, bridge) are for the
   * workspace's owners and admins; the settings pages (transcription, speech) change the whole
   * hub, so they are for its operator. Someone else who opens one is told what it is and who to
   * ask, not that they were refused.
   */
  const audience = $derived(adminAudience(page.url.pathname) ?? "workspace");
  const allowed = $derived(audience === "hub" ? auth.isHubOperator : auth.isWorkspaceAdmin);

  let isChecking = $state(true);
  let verified = $state(false);
  /** The hub said no (a 403) although the session's flags said yes. */
  let refused = $state(false);
  /** Anything else that stopped the check (hub unreachable, a 500): retryable. */
  let failure = $state<string | null>(null);
  let mounted = $state(false);
  let heading = $state<HTMLHeadingElement | null>(null);

  async function check() {
    isChecking = true;
    refused = false;
    failure = null;
    try {
      // A workspace admin can read the stats; that is the check (it stays with the hub under the
      // plane). The hub settings pages load their own data and report their own refusals.
      if (audience === "workspace") await getAdminStats();
      verified = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) refused = true;
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
    mounted = true;
  });

  // Re-checked when the audience changes (Users → Speech is a different question).
  $effect(() => {
    if (!mounted) return;
    void audience;
    if (allowed) void check();
    else isChecking = false;
  });

  const showNotFor = $derived(!isChecking && (!allowed || refused));

  // The page a member lands on replaces the one they asked for: say so to a screen reader.
  $effect(() => {
    if (showNotFor) heading?.focus();
  });
</script>

{#if isChecking}
  <main class="ap-guard" role="status">
    <Spinner size="lg" />
    <p class="text-sm text-muted-foreground">Verifying access…</p>
  </main>
{:else if showNotFor}
  <main class="ap-guard" data-testid="admin-not-for-you" aria-labelledby="admin-not-for-you-h">
    <div class="max-w-md space-y-2">
      <h1 id="admin-not-for-you-h" class="t-section text-base" tabindex="-1" bind:this={heading}>
        {audience === "hub" ? "Hub settings" : "Workspace admin"}
      </h1>
      {#if audience === "hub"}
        <p class="text-sm text-muted-foreground">
          These settings choose how voice notes are transcribed and how agents speak, for every
          workspace on this hub. They are changed by the hub's operator. {ASK_THE_OPERATOR}
        </p>
      {:else}
        <p class="text-sm text-muted-foreground">
          This is where a workspace's people, grants and bridge agents are managed. It is for the
          workspace's owners and admins. {ASK_AN_ADMIN}
        </p>
      {/if}
    </div>
    <Button variant="outline" onclick={() => goto("/")}>Back to the fleet</Button>
  </main>
{:else if failure}
  <main class="ap-guard">
    <div class="ap-alert w-full max-w-xl" role="alert">
      <p class="text-sm">{failure}</p>
      <Button variant="outline" size="sm" onclick={check}>Retry</Button>
    </div>
  </main>
{:else if verified}
  {@render children()}
{/if}
