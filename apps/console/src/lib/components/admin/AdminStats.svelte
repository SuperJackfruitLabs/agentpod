<script lang="ts">
  /**
   * AdminStats.svelte
   *
   * Four crisp stat tiles for the admin users page — total users, admins,
   * banned, and new this week. Uses the HealthPanel stat-tile vocabulary
   * (`rounded-lg border p-4`, label `text-xs text-muted-foreground`, value
   * `font-mono text-2xl font-semibold`) in place of the old cyber-card
   * corner-accent tiles.
   *
   * `AdminStats` (the type) also carries `totalSandboxes`/`runningSandboxes`
   * — deliberately not tiled here (YAGNI; the users page never showed them).
   */
  import type { AdminStats } from "@agentpod/types";

  interface Props {
    stats: AdminStats;
  }

  let { stats }: Props = $props();
</script>

<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
  <div class="rounded-lg border p-4">
    <p class="text-xs text-muted-foreground">Total users</p>
    <p class="font-mono text-2xl font-semibold">{stats.totalUsers}</p>
  </div>
  <div class="rounded-lg border p-4">
    <p class="text-xs text-muted-foreground">Admins</p>
    <p class="font-mono text-2xl font-semibold text-primary">{stats.adminUsers}</p>
  </div>
  <div class="rounded-lg border p-4">
    <p class="text-xs text-muted-foreground">Banned</p>
    <p class="font-mono text-2xl font-semibold text-destructive">{stats.bannedUsers}</p>
  </div>
  <div class="rounded-lg border p-4">
    <p class="text-xs text-muted-foreground">This week</p>
    <p class="font-mono text-2xl font-semibold">{stats.usersThisWeek}</p>
  </div>
</div>
