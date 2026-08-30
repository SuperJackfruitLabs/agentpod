<script lang="ts">
  /**
   * Grants — who may dispatch which agent.
   *
   * The control pair used to be operable only by `curl` or a database client,
   * which is not a control an organisation can actually use: an authorization
   * system nobody can inspect is one people route around. This page is the
   * inspection.
   *
   * Two things it must never do. It must not imply a grant is being enforced
   * when `ENFORCE_CONTROL_PAIR` is unset — hence the banner, driven by the
   * server's own answer rather than a build flag. And it must not hide a grant
   * whose principal no longer exists: those still match tokens if that id is ever
   * reissued, and they are exactly what nobody goes looking for.
   *
   * **Keyed by principal, not by Better Auth user.** A grant's row is
   * `principal_grants.principal_id`, a foreign key onto `principals.id`, and
   * every value in `mayDispatch` is a principal id too. This page used to list
   * Better Auth users and PUT to `/api/admin/grants/<user.id>`, which since
   * that key moved is not a grant on the wrong principal — it is a write that
   * cannot land, and every existing grant rendered as an orphan besides. The
   * directory comes from `/api/admin/principals`; users are joined onto it only
   * to put an email against a person.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { listUsers } from "$lib/api/admin";
  import {
    listGrants,
    listPrincipals,
    deleteGrant,
    type PrincipalGrant,
    type PrincipalSummary,
    type Grant,
  } from "$lib/api/grants";
  import type { AdminUserView } from "@agentpod/types";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import PageHeader from "$lib/components/page-header.svelte";
  import AdminTabs from "$lib/components/admin/AdminTabs.svelte";
  import GrantDialog from "$lib/components/admin/GrantDialog.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import ShieldOffIcon from "@lucide/svelte/icons/shield-off";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";

  const NO_GRANT: Grant = { mayDispatch: [], mayGrantReach: false };

  interface Row {
    principalId: string;
    label: string;
    sublabel: string | null;
    grant: Grant;
    granted: boolean;
    /** A grant naming a principal this hub has no record of — kept visible. */
    orphan: boolean;
  }

  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let enforced = $state(false);
  let rows = $state<Row[]>([]);
  let agentOptions = $state<Array<{ id: string; label: string }>>([]);

  let showDialog = $state(false);
  let editing = $state<Row | null>(null);
  let showRemove = $state(false);
  let removing = $state<Row | null>(null);

  /** What a principal is called, in the order a person would recognise it. */
  function nameOf(p: PrincipalSummary, user: AdminUserView | undefined): string {
    return p.displayName || user?.name || user?.email || p.handle;
  }

  async function loadData() {
    isLoading = true;
    error = null;
    try {
      // `listGrants` is the only blocking call. The directory and the user list
      // are what put a readable name on a row; without them the page still has
      // to show every grant, because narrowing one is exactly what you do when
      // something has gone wrong and a page that refused to load would be the
      // one thing standing in the way.
      const [grantsResponse, directory, usersResponse] = await Promise.all([
        listGrants(),
        listPrincipals().catch(() => [] as PrincipalSummary[]),
        listUsers({ limit: 200 }).catch(() => ({ users: [] as AdminUserView[] })),
      ]);

      enforced = grantsResponse.enforced;
      const byPrincipal = new Map<string, PrincipalGrant>(
        grantsResponse.grants.map((g) => [g.principalId, g])
      );
      const byUserId = new Map<string, AdminUserView>(
        usersResponse.users.map((u: AdminUserView) => [u.id, u])
      );

      const known: Row[] = directory.map((p) => {
        const user = p.userId ? byUserId.get(p.userId) : undefined;
        const grant = byPrincipal.get(p.id);
        byPrincipal.delete(p.id);
        return {
          principalId: p.id,
          label: nameOf(p, user),
          // The handle and the kind, because two principals can share a display
          // name and only one of them is the agent you meant to grant.
          sublabel: [p.kind, p.handle, user?.email].filter(Boolean).join(" · "),
          grant: grant ?? NO_GRANT,
          granted: grant !== undefined,
          orphan: false,
        };
      });

      // Whatever is left names a principal this hub has no record of — a deleted
      // one, or an id from another issuer. Shown last, and marked: it still
      // matches a token carrying that id, and it is exactly what nobody goes
      // looking for.
      const orphans: Row[] = [...byPrincipal.values()].map((g) => ({
        principalId: g.principalId,
        label: g.principalId,
        sublabel: null,
        grant: { mayDispatch: g.mayDispatch, mayGrantReach: g.mayGrantReach },
        granted: true,
        orphan: true,
      }));

      // Agents are what a grant's VALUES name, so they are what the dialog
      // suggests. People and services are grantees, not grantable.
      agentOptions = directory
        .filter((p) => p.kind === "agent")
        .map((p) => ({ id: p.id, label: p.displayName || p.handle }))
        .sort((a, b) => a.label.localeCompare(b.label));

      rows = [...known, ...orphans];
    } catch (e) {
      error = (e as Error).message || "Couldn’t load grants.";
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    loadData();
  });

  function openEdit(row: Row) {
    editing = row;
    showDialog = true;
  }

  function openRemove(row: Row) {
    removing = row;
    showRemove = true;
  }

  async function handleRemove() {
    if (!removing) return;
    const target = removing;
    try {
      await deleteGrant(target.principalId);
      toast.success(`Grant removed for ${target.label}`);
      await loadData();
    } catch (e) {
      toast.error("Couldn’t remove grant", { description: (e as Error).message });
    } finally {
      showRemove = false;
      removing = null;
    }
  }

  let grantedCount = $derived(rows.filter((r) => r.granted).length);
</script>

<svelte:head>
  <title>Grants · Admin · AgentPod</title>
</svelte:head>

<PageHeader title="Admin" subtitle="Who may dispatch which agent" />

<div class="container mx-auto max-w-5xl space-y-6 px-4 py-6">
  <AdminTabs active="grants" />

  {#if !isLoading && !error}
    <div
      class="flex items-start gap-3 rounded-lg border p-4 {enforced
        ? 'border-primary/40 bg-primary/5'
        : 'border-amber-500/50 bg-amber-500/5'}"
      data-testid="enforcement-banner"
    >
      {#if enforced}
        <ShieldIcon class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div class="space-y-0.5">
          <p class="text-sm font-medium">Enforced</p>
          <p class="text-xs text-muted-foreground">
            Dispatch is refused unless a grant permits it. A principal with no grant is refused
            everywhere — on this console and on the kaambaan board.
          </p>
        </div>
      {:else}
        <ShieldOffIcon class="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div class="space-y-0.5">
          <p class="text-sm font-medium">Not enforced</p>
          <p class="text-xs text-muted-foreground">
            These grants are recorded and nothing is checking them: every principal can dispatch
            every agent. Set <code>ENFORCE_CONTROL_PAIR=true</code> on the hub to make them real.
          </p>
        </div>
      {/if}
    </div>
  {/if}

  {#if isLoading}
    <div class="space-y-2">
      {#each [1, 2, 3] as _}
        <Skeleton class="h-16 rounded-sm" />
      {/each}
    </div>
  {:else if error}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <p class="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onclick={loadData}>Retry</Button>
    </div>
  {:else}
    <p class="text-xs text-muted-foreground">
      {grantedCount} of {rows.length} principals have a grant.
    </p>

    <ul class="space-y-2">
      {#each rows as row (row.principalId)}
        <li class="rounded-lg border p-4" data-testid="grant-row">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 space-y-1">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium">{row.label}</p>
                {#if row.orphan}
                  <Badge variant="outline" class="text-amber-600">No such principal</Badge>
                {/if}
                {#if row.grant.mayGrantReach}
                  <Badge variant="outline">May grant reach</Badge>
                {/if}
              </div>
              {#if row.sublabel}
                <p class="text-xs text-muted-foreground">{row.sublabel}</p>
              {/if}

              {#if row.grant.mayDispatch.length > 0}
                <ul class="flex flex-wrap gap-1 pt-1">
                  {#each row.grant.mayDispatch as value (value)}
                    <li>
                      <Badge variant="secondary" class="font-mono text-[11px]">{value}</Badge>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="pt-1 text-xs text-muted-foreground">
                  {row.granted
                    ? "Granted nothing — considered, and permitted nothing."
                    : "No grant."}
                </p>
              {/if}
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onclick={() => openEdit(row)}>
                <PencilIcon class="mr-1 h-3.5 w-3.5" />
                {row.granted ? "Edit" : "Grant"}
              </Button>
              {#if row.granted}
                <Button
                  variant="ghost"
                  size="sm"
                  class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onclick={() => openRemove(row)}
                  aria-label="Remove grant for {row.label}"
                >
                  <Trash2Icon class="h-3.5 w-3.5" />
                </Button>
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<GrantDialog
  bind:open={showDialog}
  principal={editing ? { id: editing.principalId, label: editing.label } : null}
  grant={editing?.grant ?? NO_GRANT}
  {agentOptions}
  onSaved={loadData}
/>

<ConfirmDialog
  open={showRemove}
  title="Remove grant"
  message="{removing?.label} keeps no permissions. Under enforcement they are refused everywhere — 'never considered' rather than 'considered and permitted nothing', though both deny."
  confirmLabel="Remove grant"
  destructive
  onConfirm={handleRemove}
  onCancel={() => {
    showRemove = false;
    removing = null;
  }}
/>
