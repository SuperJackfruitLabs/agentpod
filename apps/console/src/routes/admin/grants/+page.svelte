<script lang="ts">
  /**
   * Grants — who may dispatch which agent.
   *
   * The control pair used to be operable only by `curl` or a database client,
   * which is not a control an organisation can actually use: an authorization
   * system nobody can inspect is one people route around. This page is the
   * inspection.
   *
   * Three things it must never do. It must not imply a grant is being enforced
   * when `ENFORCE_CONTROL_PAIR` is unset — hence the banner, driven by the
   * server's own answer rather than a build flag. It must not hide a grant
   * whose principal no longer exists: those still match tokens if that id is
   * ever reissued, and they are exactly what nobody goes looking for. And it
   * must not print a `prn_` id where a handle exists — twenty hex characters
   * is not something anyone recognises on sight, and a permission surface
   * nobody can read is one nobody uses. Every id on this page is joined to the
   * directory first; it survives as a `title` and in the dialog, never as the
   * name of a row.
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
    suspendPrincipal,
    restorePrincipal,
    type PrincipalGrant,
    type PrincipalSummary,
    type Grant,
  } from "$lib/api/grants";
  import type { AdminUserView } from "@agentpod/types";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import PageHeader from "$lib/components/page-header.svelte";
  import AdminTabs from "$lib/components/admin/AdminTabs.svelte";
  import GrantDialog from "$lib/components/admin/GrantDialog.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import ShieldOffIcon from "@lucide/svelte/icons/shield-off";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import BanIcon from "@lucide/svelte/icons/ban";
  import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";

  const NO_GRANT: Grant = { mayDispatch: [], mayGrantReach: false };

  type Kind = PrincipalSummary["kind"] | "unknown";

  /**
   * One value of a grant, already joined to the directory.
   *
   * Resolved at load rather than in the markup: a `{@const}` lookup inside a
   * keyed `{#each}` is a derived owned by that block, and reading it while the
   * list is being rebuilt after a save is what made Svelte warn about a derived
   * belonging to a destroyed effect.
   */
  interface GrantValue {
    id: string;
    /** The agent's handle, or null when this hub has no record of that id. */
    handle: string | null;
  }

  interface Row {
    principalId: string;
    kind: Kind;
    /**
     * What this row is called. The handle — immutable, unique, and the thing an
     * agent's Matrix address is built from. An orphan has no directory entry to
     * take a handle from, so it falls back to its id, which is then genuinely
     * all that is known about it.
     */
    handle: string;
    /** The prose half: a display name, or the login behind a person. Null when neither exists. */
    detail: string | null;
    grant: Grant;
    /** `grant.mayDispatch`, with a handle against each id where one exists. */
    dispatch: GrantValue[];
    granted: boolean;
    /** A grant naming a principal this hub has no record of — kept visible. */
    orphan: boolean;
    /**
     * When this principal was suspended, or null. Null for an orphan row too
     * — there is no principal record to hold that state, so suspending one is
     * not offered.
     */
    suspendedAt: string | null;
  }

  /**
   * The groups, in the order they are shown, with the heading each one wears.
   *
   * Grouping by kind IS the kind label: a page of undifferentiated rows made
   * "can this thing dispatch that thing" a question you answered by reading
   * every row, when the answer usually turns on whether the grantee is a
   * person or a robot.
   */
  const GROUPS: Array<{ kind: Kind; heading: string; blurb: string }> = [
    { kind: "human", heading: "People", blurb: "Signed-in operators." },
    { kind: "agent", heading: "Agents", blurb: "An agent is a principal, and can hold a grant of its own." },
    { kind: "service", heading: "Services", blurb: "Machine accounts — CI, bots, the board." },
    {
      kind: "unknown",
      heading: "Unrecognised",
      blurb: "A grant naming a principal this hub has no record of. It still matches if that id is reissued.",
    },
  ];

  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let enforced = $state(false);
  let rows = $state<Row[]>([]);
  let agentOptions = $state<Array<{ id: string; label: string }>>([]);

  let showDialog = $state(false);
  let editing = $state<Row | null>(null);
  let showRemove = $state(false);
  let removing = $state<Row | null>(null);
  let showSuspend = $state(false);
  let suspending = $state<Row | null>(null);
  /** The one row with a suspend/restore request in flight — disables its own buttons only. */
  let pendingSuspendId = $state<string | null>(null);

  /**
   * The prose half of a row: what a person would call this principal, and the
   * login behind them when there is one. Never the handle again — that is
   * already the row's name, and repeating it just makes the line longer.
   */
  function detailOf(p: PrincipalSummary, user: AdminUserView | undefined): string | null {
    const parts = [p.displayName, user?.name, user?.email].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    );
    const deduped = [...new Set(parts)].filter((v) => v !== p.handle);
    return deduped.length > 0 ? deduped.join(" · ") : null;
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
      // What turns a grant's `prn_` values into handles.
      const byId = new Map(directory.map((p) => [p.id, p]));
      const resolve = (ids: string[]): GrantValue[] =>
        ids.map((id) => ({ id, handle: byId.get(id)?.handle ?? null }));

      const known: Row[] = directory.map((p) => {
        const user = p.userId ? byUserId.get(p.userId) : undefined;
        const grant = byPrincipal.get(p.id);
        byPrincipal.delete(p.id);
        return {
          principalId: p.id,
          kind: p.kind,
          handle: p.handle,
          detail: detailOf(p, user),
          grant: grant ?? NO_GRANT,
          dispatch: resolve(grant?.mayDispatch ?? []),
          granted: grant !== undefined,
          orphan: false,
          suspendedAt: p.suspendedAt,
        };
      });

      // Whatever is left names a principal this hub has no record of — a deleted
      // one, or an id from another issuer. Shown last, and marked: it still
      // matches a token carrying that id, and it is exactly what nobody goes
      // looking for. Here, and only here, the id IS the label — there is
      // nothing else known about it to use instead.
      const orphans: Row[] = [...byPrincipal.values()].map((g) => ({
        principalId: g.principalId,
        kind: "unknown" as const,
        handle: g.principalId,
        detail: null,
        grant: { mayDispatch: g.mayDispatch, mayGrantReach: g.mayGrantReach },
        dispatch: resolve(g.mayDispatch),
        granted: true,
        orphan: true,
        suspendedAt: null,
      }));

      // Agents are what a grant's VALUES name, so they are what the dialog
      // suggests. People and services are grantees, not grantable. The handle
      // is the suggestion's label for the same reason it is the row's: it is
      // what the grant will read as afterwards.
      agentOptions = directory
        .filter((p) => p.kind === "agent")
        .map((p) => ({ id: p.id, label: p.handle }))
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
      toast.success(`Grant removed for ${target.handle}`);
      await loadData();
    } catch (e) {
      toast.error("Couldn’t remove grant", { description: (e as Error).message });
    } finally {
      showRemove = false;
      removing = null;
    }
  }

  function openSuspend(row: Row) {
    suspending = row;
    showSuspend = true;
  }

  /**
   * Suspend a principal. This is the reason `/api/admin/principals` gained
   * suspend/restore at all: `buildTokenPayload` already refuses a suspended
   * principal on every path, but until this button existed that lever had no
   * surface a person could reach without a database client.
   */
  async function handleSuspend() {
    if (!suspending) return;
    const target = suspending;
    pendingSuspendId = target.principalId;
    try {
      await suspendPrincipal(target.principalId);
      toast.success(`${target.handle} suspended`);
      await loadData();
    } catch (e) {
      toast.error("Couldn’t suspend", { description: (e as Error).message });
    } finally {
      pendingSuspendId = null;
      showSuspend = false;
      suspending = null;
    }
  }

  /**
   * Lift a suspension — reversible from the same row it was applied from, on
   * purpose: a control that can only be applied and never undone is one
   * people route around rather than use.
   */
  async function handleRestore(row: Row) {
    pendingSuspendId = row.principalId;
    try {
      await restorePrincipal(row.principalId);
      toast.success(`${row.handle} restored`);
      await loadData();
    } catch (e) {
      toast.error("Couldn’t restore", { description: (e as Error).message });
    } finally {
      pendingSuspendId = null;
    }
  }

  let grantedCount = $derived(rows.filter((r) => r.granted).length);

  const grouped = $derived(
    GROUPS.map((group) => ({
      ...group,
      rows: rows.filter((r) => r.kind === group.kind),
    })).filter((group) => group.rows.length > 0)
  );
</script>

<svelte:head>
  <title>Grants · Admin · AgentPod</title>
</svelte:head>

<PageHeader title="Admin" subtitle="Who may dispatch which agent" />

<div class="container mx-auto max-w-5xl space-y-6 px-4 py-6">
  <AdminTabs active="grants" />

  {#if !isLoading && !error}
    <!--
      Colour is state, so this banner takes status tokens rather than a
      decorative accent: enforcement is a running control or an unknown one.
    -->
    <div
      class="flex items-start gap-3 rounded-lg border p-4 {enforced
        ? 'border-status-running/40 bg-status-running/5'
        : 'border-status-unknown/50 bg-status-unknown/5'}"
      data-testid="enforcement-banner"
    >
      {#if enforced}
        <ShieldIcon class="mt-0.5 h-4 w-4 shrink-0 text-status-running" />
        <div class="space-y-0.5">
          <p class="text-sm font-medium">Enforced</p>
          <p class="text-xs text-muted-foreground">
            Dispatch is refused unless a grant permits it. A principal with no grant is refused
            everywhere — on this console and on the kaambaan board.
          </p>
        </div>
      {:else}
        <ShieldOffIcon class="mt-0.5 h-4 w-4 shrink-0 text-status-unknown" />
        <div class="space-y-0.5">
          <p class="text-sm font-medium">Not enforced</p>
          <p class="text-xs text-muted-foreground">
            These grants are recorded and nothing is checking them: every principal can dispatch
            every agent. Set <code class="font-mono">ENFORCE_CONTROL_PAIR=true</code> on the hub to
            make them real.
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
      class="flex items-start justify-between gap-3 rounded-lg border border-status-error/50 bg-status-error/5 p-4"
      role="alert"
    >
      <p class="text-sm text-status-error">{error}</p>
      <Button variant="outline" size="sm" onclick={loadData}>Retry</Button>
    </div>
  {:else if rows.length === 0}
    <!-- An empty directory reads two ways — "nobody exists yet" and "the load
         quietly returned nothing" — and a bare "0 of 0 principals" said neither.
         This says what zero means. -->
    <div class="rounded-lg border border-dashed p-8 text-center" data-testid="empty-state">
      <p class="text-sm font-medium">No principals yet</p>
      <p class="mt-1 text-xs text-muted-foreground">
        Nobody — human or agent — is registered with this hub, so there is nothing to grant or
        suspend.
      </p>
    </div>
  {:else}
    <p class="text-xs text-muted-foreground">
      {grantedCount} of {rows.length} principals have a grant.
    </p>

    {#each grouped as group (group.kind)}
      <section class="space-y-2" data-testid="grant-group-{group.kind}">
        <div>
          <h2 class="text-sm font-medium text-foreground">{group.heading}</h2>
          <p class="text-xs text-muted-foreground">{group.blurb}</p>
        </div>

        <!-- Four columns of grant text do not fit a phone; they scroll in here
             rather than dragging the document sideways. -->
        <div class="overflow-x-auto rounded-lg border border-border">
          <table class="w-full min-w-[640px] text-sm">
            <thead>
              <tr class="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" class="px-3 py-2 font-medium">Principal</th>
                <th scope="col" class="px-3 py-2 font-medium">May dispatch</th>
                <th scope="col" class="px-3 py-2 font-medium">May grant reach</th>
                <!--
                  `relative` is load-bearing: an sr-only span is
                  position:absolute, and with no positioned ancestor its
                  containing block is the initial one, so this cell's label
                  escapes the overflow-x-auto above and adds to the DOCUMENT's
                  scroll width. Measured at 414px on the muster's table.
                -->
                <th scope="col" class="relative px-3 py-2 font-medium">
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {#each group.rows as row (row.principalId)}
                <tr
                  data-testid="grant-row"
                  class="relative border-b border-border/50 align-top last:border-b-0"
                >
                  <td class="max-w-[260px] px-3 py-3">
                    <div class="flex flex-wrap items-center gap-2">
                      <!--
                        The handle, not the id. `title` keeps the exact string
                        the hub compares by equality one hover away, which is
                        what an operator needs when a grant is not behaving and
                        the question becomes "is this even the same principal?".
                      -->
                      <span
                        class="truncate font-mono font-medium"
                        title={row.principalId}
                        data-testid="principal-handle"
                      >
                        {row.handle}
                      </span>
                      {#if row.suspendedAt}
                        <span
                          class="rounded border border-status-error/50 px-1.5 py-0.5 text-[11px] text-status-error"
                        >
                          Suspended
                        </span>
                      {/if}
                    </div>
                    {#if row.detail}
                      <p class="truncate text-xs text-muted-foreground">{row.detail}</p>
                    {/if}
                    {#if row.orphan}
                      <p class="text-xs text-status-unknown">No such principal</p>
                    {/if}
                  </td>

                  <td class="px-3 py-3">
                    {#if row.dispatch.length > 0}
                      <ul class="flex flex-wrap gap-1">
                        {#each row.dispatch as value (value.id)}
                          <li>
                            <span
                              class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px]"
                              title={value.id}
                              data-testid="grant-value"
                            >
                              <!-- The agent's handle when this hub knows it. A
                                   value it does not know still shows in full:
                                   an unrecognised grant is the one worth
                                   reading character by character. -->
                              {value.handle ?? value.id}
                              {#if !value.handle}
                                <span class="font-sans text-status-unknown">unknown</span>
                              {/if}
                            </span>
                          </li>
                        {/each}
                      </ul>
                    {:else}
                      <span class="text-xs text-muted-foreground">
                        {row.granted
                          ? "Granted nothing — considered, and permitted nothing."
                          : "No grant."}
                      </span>
                    {/if}
                  </td>

                  <td class="px-3 py-3 text-xs">
                    {#if row.grant.mayGrantReach}
                      <span class="text-foreground">Yes</span>
                    {:else}
                      <span class="text-muted-foreground">No</span>
                    {/if}
                  </td>

                  <td class="px-3 py-3">
                    <div class="flex items-center justify-end gap-1">
                      <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => openEdit(row)}>
                        <PencilIcon class="mr-1 h-3.5 w-3.5" />
                        {row.granted ? "Edit" : "Grant"}
                      </Button>
                      {#if !row.orphan}
                        {#if row.suspendedAt}
                          <Button
                            variant="outline"
                            size="sm"
                            class="h-7 px-2 text-xs"
                            onclick={() => handleRestore(row)}
                            disabled={pendingSuspendId === row.principalId}
                            aria-label="Restore {row.handle}"
                          >
                            <RotateCcwIcon class="mr-1 h-3.5 w-3.5" />
                            Restore
                          </Button>
                        {:else}
                          <Button
                            variant="ghost"
                            size="sm"
                            class="h-7 px-2 text-xs text-status-error hover:bg-status-error/10 hover:text-status-error"
                            onclick={() => openSuspend(row)}
                            disabled={pendingSuspendId === row.principalId}
                            aria-label="Suspend {row.handle}"
                          >
                            <BanIcon class="mr-1 h-3.5 w-3.5" />
                            Suspend
                          </Button>
                        {/if}
                      {/if}
                      {#if row.granted}
                        <Button
                          variant="ghost"
                          size="sm"
                          class="h-7 px-2 text-xs text-status-error hover:bg-status-error/10 hover:text-status-error"
                          onclick={() => openRemove(row)}
                          aria-label="Remove grant for {row.handle}"
                        >
                          <Trash2Icon class="h-3.5 w-3.5" />
                        </Button>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/each}
  {/if}
</div>

<GrantDialog
  bind:open={showDialog}
  principal={editing ? { id: editing.principalId, label: editing.handle } : null}
  grant={editing?.grant ?? NO_GRANT}
  {agentOptions}
  onSaved={loadData}
/>

<ConfirmDialog
  open={showRemove}
  title="Remove grant"
  message="{removing?.handle} keeps no permissions. Under enforcement they are refused everywhere — 'never considered' rather than 'considered and permitted nothing', though both deny."
  confirmLabel="Remove grant"
  destructive
  onConfirm={handleRemove}
  onCancel={() => {
    showRemove = false;
    removing = null;
  }}
/>

<ConfirmDialog
  open={showSuspend}
  title="Suspend principal"
  message="{suspending?.handle} will be refused everywhere, on both planes — no token is minted for a suspended principal, session or agent alike. Reversible from this same page at any time."
  confirmLabel="Suspend"
  destructive
  onConfirm={handleSuspend}
  onCancel={() => {
    showSuspend = false;
    suspending = null;
  }}
/>
