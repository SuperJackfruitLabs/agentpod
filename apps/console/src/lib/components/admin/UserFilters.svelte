<script lang="ts">
  /**
   * UserFilters.svelte
   *
   * Search + role/status filters + refresh for the admin users page,
   * extracted from the page's inline filter bar. Trigger labels come from
   * lookup maps instead of nested nested ternaries.
   */
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import SearchIcon from "@lucide/svelte/icons/search";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import type { UserRole } from "@agentpod/types";

  type RoleFilter = UserRole | "all";
  type BannedFilter = "all" | "banned" | "active";

  interface Props {
    searchQuery: string;
    roleFilter: RoleFilter;
    bannedFilter: BannedFilter;
    onSearch: () => void;
    onRefresh: () => void;
    isLoading: boolean;
  }

  let {
    searchQuery = $bindable(""),
    roleFilter = $bindable("all"),
    bannedFilter = $bindable("all"),
    onSearch,
    onRefresh,
    isLoading,
  }: Props = $props();

  const roleFilterLabel: Record<RoleFilter, string> = {
    all: "All roles",
    admin: "Admin",
    user: "User",
  };

  const bannedFilterLabel: Record<BannedFilter, string> = {
    all: "All status",
    active: "Active",
    banned: "Banned",
  };
</script>

<div class="flex flex-wrap items-center gap-4">
  <!-- Search -->
  <div class="flex-1 min-w-[200px] relative">
    <SearchIcon class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
    <Input
      type="text"
      placeholder="Search by email or name..."
      bind:value={searchQuery}
      onkeydown={(e) => e.key === "Enter" && onSearch()}
      class="pl-9"
    />
  </div>

  <!-- Role filter -->
  <Select.Root
    type="single"
    value={roleFilter}
    onValueChange={(v) => {
      if (v) roleFilter = v as RoleFilter;
    }}
  >
    <Select.Trigger class="w-32">
      {roleFilterLabel[roleFilter]}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="all">All roles</Select.Item>
      <Select.Item value="admin">Admin</Select.Item>
      <Select.Item value="user">User</Select.Item>
    </Select.Content>
  </Select.Root>

  <!-- Banned filter -->
  <Select.Root
    type="single"
    value={bannedFilter}
    onValueChange={(v) => {
      if (v) bannedFilter = v as BannedFilter;
    }}
  >
    <Select.Trigger class="w-32">
      {bannedFilterLabel[bannedFilter]}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="all">All status</Select.Item>
      <Select.Item value="active">Active</Select.Item>
      <Select.Item value="banned">Banned</Select.Item>
    </Select.Content>
  </Select.Root>

  <!-- Search button -->
  <Button onclick={onSearch}>
    <SearchIcon class="h-4 w-4 mr-2" />
    Search
  </Button>

  <!-- Refresh -->
  <Button variant="outline" onclick={onRefresh} disabled={isLoading}>
    <RefreshIcon class="h-4 w-4 {isLoading ? 'animate-spin' : ''}" />
  </Button>
</div>
