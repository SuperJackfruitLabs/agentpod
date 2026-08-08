<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { getUser, unbanUser } from "$lib/api/admin";
  import type { AdminUserView } from "@agentpod/types";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import PageHeader from "$lib/components/page-header.svelte";
  import BanUserDialog from "$lib/components/admin/BanUserDialog.svelte";
  import RoleDialog from "$lib/components/admin/RoleDialog.svelte";
  import { formatDate } from "$lib/utils/format-date";
  import { statusBadgeClass } from "$lib/utils/status-badge";

  // Icons
  import UserIcon from "@lucide/svelte/icons/user";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import BanIcon from "@lucide/svelte/icons/ban";
  import CheckIcon from "@lucide/svelte/icons/check";

  // Route param
  let userId = $derived(page.params.id ?? "");

  // State
  let isLoading = $state(true);
  let user = $state<AdminUserView | null>(null);
  let error = $state<string | null>(null);

  // Action dialogs
  let showBanDialog = $state(false);
  let showRoleDialog = $state(false);
  let actionLoading = $state(false);

  // Load user data
  async function loadUser() {
    if (!userId) return;

    isLoading = true;
    error = null;

    try {
      const response = await getUser(userId);
      user = response.user;
    } catch (e) {
      const err = e as Error;
      error = err.message || "Failed to load user";
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    loadUser();
  });

  // Unban user
  async function handleUnban() {
    if (!user) return;

    actionLoading = true;
    try {
      await unbanUser(user.id);
      toast.success(`${user.email} has been unbanned`);
      loadUser();
    } catch (e) {
      const err = e as Error;
      toast.error("Failed to unban user", { description: err.message });
    } finally {
      actionLoading = false;
    }
  }
</script>

<svelte:head>
  <title>{user?.email ?? "User"} · Admin · AgentPod</title>
</svelte:head>

<main class="flex h-screen flex-col overflow-hidden">
  <!-- Header -->
  <PageHeader
    title={user?.name || user?.email || "User Details"}
    icon={UserIcon}
    subtitle={user?.email || "Loading..."}
    status={user
      ? user.banned
        ? { label: "Banned", variant: "error" }
        : { label: "Active", variant: "running" }
      : undefined}
  >
    {#snippet leading()}
      <Button
        variant="ghost"
        size="icon"
        href="/admin/users"
        class="h-8 w-8"
        title="Back to users"
        aria-label="Back to users"
      >
        <ArrowLeftIcon class="h-4 w-4" />
      </Button>
    {/snippet}
  </PageHeader>

  <!-- Content -->
  <div class="flex-1 overflow-y-auto">
    <div class="container mx-auto max-w-3xl space-y-6 px-4 py-6">
      {#if isLoading}
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-16 rounded-lg" />
          {/each}
        </div>
      {:else if error}
        <div
          class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
          role="alert"
        >
          <p class="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onclick={loadUser}>Retry</Button>
        </div>
      {:else if user}
        <!-- User Info Card -->
        <div class="rounded-lg border bg-card p-6">
          <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <!-- Identity -->
            <div class="flex items-center gap-4">
              {#if user.image}
                <img src={user.image} alt={user.name} class="h-14 w-14 rounded-full" />
              {:else}
                <div class="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-xl font-medium text-primary">
                  {user.name?.[0] || user.email[0]}
                </div>
              {/if}
              <div>
                <h2 class="text-base font-medium">{user.name || "—"}</h2>
                <p class="text-sm text-muted-foreground">{user.email}</p>
                <div class="mt-2 flex items-center gap-2">
                  <Badge variant={user.role === "admin" ? "default" : "outline"}>
                    {user.role}
                  </Badge>
                  <Badge variant="outline" class={statusBadgeClass(user.banned ? "banned" : "active")}>
                    {user.banned ? "Banned" : "Active"}
                  </Badge>
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onclick={() => (showRoleDialog = true)}
                data-testid="change-role"
              >
                <ShieldIcon class="mr-2 h-4 w-4" />
                Change Role
              </Button>
              {#if user.banned}
                <Button variant="outline" onclick={handleUnban} disabled={actionLoading}>
                  <CheckIcon class="mr-2 h-4 w-4" />
                  {actionLoading ? "Unbanning…" : "Unban"}
                </Button>
              {:else}
                <Button
                  variant="outline"
                  onclick={() => (showBanDialog = true)}
                  data-testid="ban-user"
                  class="border-destructive/50 text-destructive hover:bg-destructive/10"
                >
                  <BanIcon class="mr-2 h-4 w-4" />
                  Ban User
                </Button>
              {/if}
            </div>
          </div>

          {#if user.banned && user.bannedReason}
            <div class="mt-4 rounded-lg border border-destructive/50 bg-destructive/5 p-3">
              <p class="mb-1 text-xs font-medium text-destructive">Ban reason</p>
              <p class="text-sm">{user.bannedReason}</p>
              {#if user.bannedAt}
                <p class="mt-1 text-xs text-muted-foreground">
                  Banned on {formatDate(user.bannedAt, "long")}
                </p>
              {/if}
            </div>
          {/if}

          <!-- Meta Info -->
          <div class="mt-4 grid grid-cols-2 gap-4 border-t pt-4 text-sm md:grid-cols-3">
            <div>
              <p class="text-xs text-muted-foreground">User ID</p>
              <p class="break-all font-mono text-xs">{user.id}</p>
            </div>
            <div>
              <p class="text-xs text-muted-foreground">Joined</p>
              <p class="font-mono text-xs">{formatDate(user.createdAt, "long")}</p>
            </div>
            <div>
              <p class="text-xs text-muted-foreground">Email Verified</p>
              <p class="text-xs">{user.emailVerified ? "Yes" : "No"}</p>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</main>

<BanUserDialog bind:open={showBanDialog} user={user} onBanned={loadUser} />
<RoleDialog bind:open={showRoleDialog} user={user} onChanged={loadUser} />
