<script lang="ts">
  // Orchestrator only — composes the shared admin/* components on top of
  // DataTable's manualPagination mode; server owns search/filter/paging.
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import {
    listUsers,
    getAdminStats,
    getSignupStatus,
    enableSignup,
    disableSignup,
    unbanUser,
    type ListUsersOptions,
  } from "$lib/api/admin";
  import type { AdminUserView, AdminStats as AdminStatsType, UserRole } from "@agentpod/types";
  import type { ColumnDef } from "@tanstack/table-core";
  import { DataTable, renderSnippet } from "$lib/components/ui/data-table";
  import { Button } from "$lib/components/ui/button";
  import { Badge, badgeVariants } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import PageHeader from "$lib/components/page-header.svelte";
  import AdminStats from "$lib/components/admin/AdminStats.svelte";
  import AdminSettingsBar from "$lib/components/admin/AdminSettingsBar.svelte";
  import UserFilters from "$lib/components/admin/UserFilters.svelte";
  import BanUserDialog from "$lib/components/admin/BanUserDialog.svelte";
  import RoleDialog from "$lib/components/admin/RoleDialog.svelte";
  import CreateUserDialog from "$lib/components/admin/CreateUserDialog.svelte";
  import { formatDate } from "$lib/utils/format-date";
  import { statusBadgeClass } from "$lib/utils/status-badge";
  import { cn } from "$lib/utils";
  import BanIcon from "@lucide/svelte/icons/ban";
  import CheckIcon from "@lucide/svelte/icons/check";

  const PAGE_SIZE = 20;

  // Data
  let isLoading = $state(true);
  let users = $state<AdminUserView[]>([]);
  let total = $state(0);
  let stats = $state<AdminStatsType | null>(null);
  let error = $state<string | null>(null);
  let signupEnabled = $state(true);
  let signupLoading = $state(false);

  // Server-driven pagination (0-based, matches DataTable's manual mode)
  let pageIndex = $state(0);
  let pageCount = $derived(total > 0 ? Math.ceil(total / PAGE_SIZE) : 0);

  // Filters (server-side — refetched on Search/refresh, not client-filtered)
  let searchQuery = $state("");
  let roleFilter = $state<UserRole | "all">("all");
  let bannedFilter = $state<"all" | "banned" | "active">("all");
  let hasActiveFilters = $derived(
    searchQuery.trim() !== "" || roleFilter !== "all" || bannedFilter !== "all"
  );
  let emptyDescription = $derived(
    hasActiveFilters ? "Try adjusting your filters" : "No users exist yet"
  );

  // Dialogs
  let showBanDialog = $state(false);
  let showRoleDialog = $state(false);
  let showCreateUserDialog = $state(false);
  let selectedUser = $state<AdminUserView | null>(null);
  let actionLoading = $state<Record<string, boolean>>({});

  async function loadData() {
    isLoading = true;
    error = null;
    try {
      const options: ListUsersOptions = { limit: PAGE_SIZE, offset: pageIndex * PAGE_SIZE };
      if (searchQuery.trim()) options.search = searchQuery.trim();
      if (roleFilter !== "all") options.role = roleFilter;
      if (bannedFilter !== "all") options.banned = bannedFilter === "banned";

      const [usersResponse, statsResponse, signupResponse] = await Promise.all([
        listUsers(options),
        getAdminStats(),
        getSignupStatus(),
      ]);

      users = usersResponse.users;
      total = usersResponse.total;
      stats = statsResponse;
      signupEnabled = signupResponse.enabled;
    } catch (e) {
      error = (e as Error).message || "Failed to load users";
    } finally {
      isLoading = false;
    }
  }

  onMount(loadData);

  function handleSearch() {
    pageIndex = 0;
    loadData();
  }
  function goToPage(index: number) {
    pageIndex = index;
    loadData();
  }
  function openBanDialog(user: AdminUserView) {
    selectedUser = user;
    showBanDialog = true;
  }
  function openRoleDialog(user: AdminUserView) {
    selectedUser = user;
    showRoleDialog = true;
  }
  const openCreateUserDialog = () => (showCreateUserDialog = true);

  async function handleUnban(user: AdminUserView) {
    actionLoading[user.id] = true;
    try {
      await unbanUser(user.id);
      toast.success(`${user.email} has been unbanned`);
      await loadData();
    } catch (e) {
      toast.error("Failed to unban user", { description: (e as Error).message });
    } finally {
      delete actionLoading[user.id];
    }
  }

  async function handleToggleSignup() {
    signupLoading = true;
    try {
      if (signupEnabled) {
        await disableSignup();
        signupEnabled = false;
        toast.success("Public signup disabled");
      } else {
        await enableSignup();
        signupEnabled = true;
        toast.success("Public signup enabled");
      }
    } catch (e) {
      toast.error("Failed to update signup settings", { description: (e as Error).message });
    } finally {
      signupLoading = false;
    }
  }

  // Cell snippets are declared below; referenced here safely — they only run
  // later, when FlexRender invokes them (see runtimes/+page.svelte).
  const columns: ColumnDef<AdminUserView>[] = [
    { id: "user", header: "User", enableSorting: false, cell: (ctx) => renderSnippet(userCell, { user: ctx.row.original }) },
    { id: "role", header: "Role", enableSorting: false, cell: (ctx) => renderSnippet(roleCell, { user: ctx.row.original }) },
    { id: "status", header: "Status", enableSorting: false, cell: (ctx) => renderSnippet(statusCell, { user: ctx.row.original }) },
    { accessorKey: "createdAt", header: "Joined", enableSorting: false, cell: (ctx) => renderSnippet(joinedCell, { value: ctx.getValue<string>() }) },
    { id: "actions", header: "Actions", enableSorting: false, cell: (ctx) => renderSnippet(actionsCell, { user: ctx.row.original }) },
  ];
</script>

{#snippet userCell({ user }: { user: AdminUserView })}
  <a href="/admin/users/{user.id}" class="flex items-center gap-3 hover:text-primary transition-colors">
    {#if user.image}
      <img src={user.image} alt={user.name} class="h-8 w-8 rounded-full" />
    {:else}
      <div class="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
        {user.name?.[0] || user.email[0]}
      </div>
    {/if}
    <div>
      <p class="text-sm font-medium">{user.name || "—"}</p>
      <p class="text-xs text-muted-foreground">{user.email}</p>
    </div>
  </a>
{/snippet}

{#snippet roleCell({ user }: { user: AdminUserView })}
  <button type="button" onclick={() => openRoleDialog(user)} data-testid="role-badge" class={cn(badgeVariants({ variant: user.role === "admin" ? "default" : "outline" }), "cursor-pointer")}>
    {user.role}
  </button>
{/snippet}

{#snippet statusCell({ user }: { user: AdminUserView })}
  <Badge variant="outline" class={statusBadgeClass(user.banned ? "banned" : "active")}>
    {user.banned ? "Banned" : "Active"}
  </Badge>
{/snippet}

{#snippet joinedCell({ value }: { value: string })}
  <span class="text-xs text-muted-foreground whitespace-nowrap">{formatDate(value)}</span>
{/snippet}

{#snippet actionsCell({ user }: { user: AdminUserView })}
  <div class="flex items-center justify-end gap-2">
    {#if user.banned}
      <Button variant="ghost" size="sm" onclick={() => handleUnban(user)} disabled={!!actionLoading[user.id]} data-testid="unban-btn">
        <CheckIcon class="h-4 w-4 mr-1" />
        {actionLoading[user.id] ? "Unbanning…" : "Unban"}
      </Button>
    {:else}
      <Button variant="ghost" size="sm" onclick={() => openBanDialog(user)} disabled={!!actionLoading[user.id]} data-testid="ban-btn" class="text-destructive hover:text-destructive hover:bg-destructive/10">
        <BanIcon class="h-4 w-4 mr-1" />
        Ban
      </Button>
    {/if}
    <Button variant="outline" size="sm" href="/admin/users/{user.id}">View</Button>
  </div>
{/snippet}

<PageHeader title="Admin" subtitle="User management" />

<div class="container mx-auto max-w-6xl space-y-6 px-4 py-6">
  {#if stats}
    <AdminStats {stats} />
  {/if}

  <AdminSettingsBar {signupEnabled} {signupLoading} onToggle={handleToggleSignup} onCreateUser={openCreateUserDialog} />

  <UserFilters bind:searchQuery bind:roleFilter bind:bannedFilter onSearch={handleSearch} onRefresh={loadData} onFilterChange={handleSearch} {isLoading} />

  {#if isLoading}
    <div class="space-y-2">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-12 rounded-sm" />
      {/each}
    </div>
  {:else if error}
    <div class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4" role="alert">
      <p class="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onclick={loadData}>Retry</Button>
    </div>
  {:else}
    <DataTable
      {columns}
      data={users}
      emptyTitle="No users found"
      {emptyDescription}
      manualPagination
      {pageCount}
      bind:pageIndex
      onPageChange={goToPage}
      rowTestId="user-row"
    />
  {/if}
</div>

<BanUserDialog bind:open={showBanDialog} user={selectedUser} onBanned={loadData} />
<RoleDialog bind:open={showRoleDialog} user={selectedUser} onChanged={loadData} />
<CreateUserDialog bind:open={showCreateUserDialog} onCreated={loadData} />
