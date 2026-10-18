<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth, logout, currentPlane } from "$lib/stores/auth.svelte";
  import ManagedByPlane from "$lib/components/org-plane/ManagedByPlane.svelte";
  import { connection, disconnect } from "$lib/stores/connection.svelte";
  import PageHeader from "$lib/components/page-header.svelte";
  import DeviceList from "$lib/components/device-list.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import AppearanceControl from "$lib/components/shell/AppearanceControl.svelte";

  // Under the org plane a terminal's device credential is the plane's (the hub's device routes
  // answer 410), so the list moves there.
  let plane = $derived(currentPlane());

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

<div class="ap-page">

  <!-- Appearance: the same control as the account menu and the phone's More sheet -->
  <section class="ap-card" aria-labelledby="settings-appearance">
    <h2 id="settings-appearance" class="ap-h2 mb-3.5">Appearance</h2>
    <AppearanceControl idPrefix="settings-appearance" />
  </section>

  <!-- Connection -->
  <section class="ap-card" aria-labelledby="settings-connection">
    <h2 id="settings-connection" class="ap-h2 mb-3.5">Connection</h2>
    <div class="ap-row">
      <p class="min-w-0">
        <span class="ap-lbl">Connected to</span>
        <span class="ap-value">{connection.apiUrl ?? "—"}</span>
      </p>
      <Button variant="outline" onclick={handleDisconnect}>
        Use a different hub
      </Button>
    </div>
  </section>

  <!-- Devices — the revocation surface the device-credential record asks for -->
  <section class="ap-card">
    {#if plane}
      <h2 class="ap-h2 mb-3.5">Devices</h2>
      <ManagedByPlane what="Devices" href={plane.url} />
    {:else}
      <DeviceList />
    {/if}
  </section>

  <!-- Account -->
  <section class="ap-card" aria-labelledby="settings-account">
    <h2 id="settings-account" class="ap-h2 mb-3.5">Account</h2>
    {#if auth.user}
      <dl class="ap-kv">
        {#if auth.user.name}
          <dt>Name</dt>
          <dd>{auth.user.name}</dd>
        {/if}
        <dt>Email</dt>
        <dd>{auth.user.email}</dd>
        {#if auth.user.role}
          <dt>Role</dt>
          <dd><Badge variant="secondary">{auth.user.role}</Badge></dd>
        {/if}
      </dl>
    {:else}
      <p class="mb-4 text-sm text-muted-foreground">Not signed in.</p>
    {/if}
    <Button variant="outline" onclick={handleSignOut} data-testid="sign-out">
      Sign out
    </Button>
  </section>

</div>
