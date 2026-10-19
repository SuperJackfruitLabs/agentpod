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

<dl class="ap-stats">
  <div class="ap-stat">
    <dt>Total users</dt>
    <dd>{stats.totalUsers}</dd>
  </div>
  <div class="ap-stat" data-tone="accent">
    <dt>Admins</dt>
    <dd>{stats.adminUsers}</dd>
  </div>
  <div class="ap-stat" data-tone={stats.bannedUsers > 0 ? "danger" : undefined}>
    <dt>Banned</dt>
    <dd>{stats.bannedUsers}</dd>
  </div>
  <div class="ap-stat">
    <dt>This week</dt>
    <dd>{stats.usersThisWeek}</dd>
  </div>
</dl>
