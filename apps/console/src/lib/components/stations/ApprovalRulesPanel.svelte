<script lang="ts">
  import * as api from "$lib/api/approval-rules";
  import { workspaceAdminsCan } from "$lib/workspace-authority";

  // The agent's standing "Always allow" rule for workspace writes (approval scopes). Workspace
  // owners and admins set or revoke it; a revocation reaches a run in flight at its next renewal.
  // Deletes, hidden files, commands and network always ask, whatever this says.
  let { stationId, canChange }: { stationId: string; canChange: boolean } = $props();
  let rule = $state<api.ApprovalRule | null>(null);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let epoch = 0;

  $effect(() => {
    const id = stationId;
    const ticket = ++epoch;
    loaded = false;
    error = null;
    void api
      .listApprovalRules(id)
      .then((rules) => {
        if (ticket !== epoch) return;
        rule = rules.find((r) => r.scope === "workspace-write") ?? null;
        loaded = true;
      })
      .catch((e) => { if (ticket === epoch) error = e instanceof Error ? e.message : "Could not read the approval rules"; });
    return () => { epoch++; };
  });

  async function toggle() {
    if (!canChange || busy || !loaded) return;
    busy = true;
    error = null;
    try {
      if (rule) {
        await api.revokeApprovalRule(stationId, rule.id);
        rule = null;
      } else {
        rule = await api.setApprovalRule(stationId, "workspace-write");
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not change the rule";
    } finally {
      busy = false;
    }
  }
</script>

<section class="space-y-2 border-b p-4" aria-labelledby="approval-rules-heading">
  <div class="flex items-center justify-between gap-4">
    <div class="space-y-1">
      <h2 id="approval-rules-heading" class="font-semibold">Always allow workspace writes</h2>
      <p class="text-sm text-muted-foreground">
        Board work by this agent writes files in its workspace without asking each time. Deletes, hidden
        files, commands and network still ask.
      </p>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={rule ? "true" : "false"}
      aria-labelledby="approval-rules-heading"
      disabled={!canChange || busy || !loaded}
      onclick={toggle}
      class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 {rule ? 'bg-foreground' : 'bg-muted'}"
    >
      <span class="inline-block h-4 w-4 rounded-full bg-background transition-transform {rule ? 'translate-x-6' : 'translate-x-1'}"></span>
    </button>
  </div>
  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {:else if rule}
    <p class="text-xs text-muted-foreground">Set by {rule.setBy} on {new Date(rule.setAt).toLocaleString()}. Turning it off applies to runs in progress too.</p>
  {/if}
  {#if !canChange}
    <p class="text-xs text-muted-foreground">{workspaceAdminsCan("change this rule")}</p>
  {/if}
</section>
