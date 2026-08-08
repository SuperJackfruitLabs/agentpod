<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth, logout } from "$lib/stores/auth.svelte";
  import { connection, disconnect } from "$lib/stores/connection.svelte";
  import ThemeSettings from "$lib/components/theme-settings.svelte";
  import PageHeader from "$lib/components/page-header.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";

  async function handleDisconnect() {
    await disconnect();
    goto("/login");
  }

  async function handleSignOut() {
    await logout();
    goto("/login");
  }
</script>

<svelte:head>
  <title>Settings · AgentPod</title>
</svelte:head>

<PageHeader title="Settings" />

<div class="container mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">

  <!-- Appearance -->
  <div class="rounded-lg border bg-card p-6 space-y-4">
    <h2 class="t-section">Appearance</h2>
    <ThemeSettings />
  </div>

  <!-- Connection -->
  <div class="rounded-lg border bg-card p-6 space-y-4">
    <h2 class="t-section">Connection</h2>
    <div class="space-y-1">
      <p class="text-xs text-muted-foreground">Connected to</p>
      <p class="font-mono text-sm break-all rounded border bg-muted/30 p-2">
        {connection.apiUrl ?? "—"}
      </p>
    </div>
    <Button variant="outline" onclick={handleDisconnect}>
      Use different server
    </Button>
  </div>

  <!-- Account -->
  <div class="rounded-lg border bg-card p-6 space-y-4">
    <h2 class="t-section">Account</h2>
    {#if auth.user}
      <div class="space-y-2 text-sm">
        {#if auth.user.name}
          <div class="flex items-baseline gap-2">
            <span class="text-xs text-muted-foreground">Name</span>
            <span>{auth.user.name}</span>
          </div>
        {/if}
        <div class="flex items-baseline gap-2">
          <span class="text-xs text-muted-foreground">Email</span>
          <span>{auth.user.email}</span>
        </div>
        {#if auth.user.role}
          <div class="flex items-baseline gap-2">
            <span class="text-xs text-muted-foreground">Role</span>
            <Badge variant="secondary">{auth.user.role}</Badge>
          </div>
        {/if}
      </div>
    {:else}
      <p class="text-sm text-muted-foreground">Not signed in.</p>
    {/if}
    <Button variant="outline" onclick={handleSignOut} data-testid="sign-out">
      Sign out
    </Button>
  </div>

</div>
