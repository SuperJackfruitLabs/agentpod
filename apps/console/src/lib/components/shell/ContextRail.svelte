<script lang="ts">
  /**
   * ContextRail — who this agent IS, where it RUNS, and who may DISPATCH it.
   *
   * Everything here used to be either scattered across the station page's
   * tabs or absent entirely: the mxid lived in a card stacked above the
   * conversation, the principal id lived nowhere at all, and "who may
   * dispatch it" was only ever answerable by reading the whole grants table
   * backwards. It is chrome for the page it sits beside, so it never fetches
   * the station — the page already has it.
   *
   * **The grant section is admin-only, and is not asked for otherwise.**
   * `GET /api/admin/grants` answers 403 to everyone else, and a 403 on every
   * station visit is noise in the hub's log that tells the operator nothing.
   * A non-admin gets Identity and Placement and one line saying so.
   */
  import type { NodeSummary } from "@agentpod/contract";
  import type { StationRow } from "$lib/api/client";
  import {
    listGrants as defaultListGrants,
    listPrincipals as defaultListPrincipals,
    type PrincipalGrant,
    type PrincipalSummary,
  } from "$lib/api/grants";
  import { auth } from "$lib/stores/auth.svelte";
  import MatrixIdentityPanel from "$lib/components/stations/MatrixIdentityPanel.svelte";
  import PurposeField from "$lib/components/purpose/PurposeField.svelte";

  interface Props {
    station: StationRow | null;
    /** The node this station sits on, when the fleet snapshot has it. */
    node?: NodeSummary | null;
    /** The node's agent binary version — the fleet snapshot's copy is fine. */
    agentVersion?: string | null;
    onSavePurpose?: (purpose: string | null) => Promise<void>;
    /** Injected by tests. Defaults to this session's role. */
    isAdmin?: boolean;
    listGrants?: typeof defaultListGrants;
    listPrincipals?: typeof defaultListPrincipals;
  }

  let {
    station,
    node = null,
    agentVersion = null,
    onSavePurpose,
    isAdmin,
    listGrants = defaultListGrants,
    listPrincipals = defaultListPrincipals,
  }: Props = $props();

  const admin = $derived(isAdmin ?? auth.user?.role === "admin");

  /**
   * The address this station actually answers on.
   *
   * There are two columns and they are not interchangeable. `matrixId` is what
   * the HARNESS reports — the node agent owns it, and it is null for a station
   * that answers through the bridge. `bridgeMatrixId` is what the Application
   * Service minted, which is the address a bridge-mode station is reachable at.
   *
   * Reading only `matrixId` is why every openclaw station on ashram showed
   * "—" here while Supermessage was quite happily talking to
   * `@agent_annapurna:id.agentpod.dev`. The hub was already sending it: the
   * stations route is a bare `db.select()`, so the whole row arrives, and this
   * panel was picking the wrong half of it.
   */
  const matrixAddress = $derived(station?.matrixId ?? station?.bridgeMatrixId ?? null);

  /**
   * Who answers for this station, from the column that records it.
   *
   * Previously inferred from `matrixId === null`, which happens to be right for
   * a settled fleet and wrong exactly when it matters: a HARNESS-mode station
   * that has not yet reported its own mxid also has a null `matrixId`, and was
   * therefore described as one the bridge speaks for — the opposite of the
   * truth, on the station whose identity is mid-flight. `matrixIdentityMode` is
   * the hub's own answer and it is in the payload.
   */
  const credentialMode = $derived(
    station === null
      ? null
      : station.matrixIdentityMode === "harness"
        ? "Held by the agent itself"
        : "The bridge speaks for it",
  );

  // ─── Who may dispatch it ──────────────────────────────────────────────────

  type GrantLoad =
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "loaded"; holders: string[]; enforced: boolean }
    | { phase: "error"; message: string };

  let grants = $state<GrantLoad>({ phase: "idle" });

  /** What has already been asked, so an unrelated re-render doesn't re-ask. */
  let askedFor: string | null = null;

  $effect(() => {
    const principalId = station?.principalId ?? null;
    // No occupant means no grant can name it, and no admin endpoint needs
    // troubling to find that out.
    if (!admin || principalId === null) return;
    if (askedFor === principalId) return;
    askedFor = principalId;

    let live = true;
    grants = { phase: "loading" };
    void Promise.all([
      listGrants(),
      // A name for each holder is a nicety; a grant nobody can read is not.
      // The directory failing leaves the prn_ ids visible rather than the
      // whole section.
      listPrincipals().catch(() => [] as PrincipalSummary[]),
    ])
      .then(([grantsResponse, directory]) => {
        if (!live) return;
        const nameOf = new Map(directory.map((p) => [p.id, p.handle]));
        const holders = grantsResponse.grants
          .filter((g: PrincipalGrant) => g.mayDispatch.includes(principalId))
          .map((g: PrincipalGrant) => nameOf.get(g.principalId) ?? g.principalId);
        grants = { phase: "loaded", holders, enforced: grantsResponse.enforced };
      })
      .catch((e: unknown) => {
        if (!live) return;
        grants = {
          phase: "error",
          message: e instanceof Error ? e.message : "Couldn't read the grants.",
        };
      });

    return () => {
      live = false;
    };
  });
</script>

<!--
  `relative` is load-bearing, not decoration. The shell's context column is a
  scroller; an `sr-only` descendant (PurposeField's label, anything a re-hosted
  panel brings) is `position:absolute`, and with no positioned ancestor INSIDE
  the scroller its containing block is the initial one — it escapes the
  clipping entirely and adds to the document's scroll width. That has already
  broken two pages in this redesign.
-->
<div class="relative flex flex-col gap-5 p-4 text-sm" data-testid="station-context">
  {#if station === null}
    <p class="text-muted-foreground">Nothing selected.</p>
  {:else}
    <!-- ── Identity ─────────────────────────────────────────────────────── -->
    <section data-testid="rail-identity">
      <h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Identity
      </h2>
      <dl class="space-y-2">
        <div>
          <dt class="text-xs text-muted-foreground">Handle</dt>
          <!-- The agent's principal handle is not on the station row, and the
               directory that holds it is admin-only. This is the name the
               station answers to, which is the nearest fact every reader has. -->
          <dd class="font-mono break-all" data-testid="rail-handle">{station.displayName}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Matrix address</dt>
          <dd class="font-mono break-all" data-testid="rail-mxid">
            {matrixAddress ?? "—"}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Principal</dt>
          <dd class="font-mono break-all" data-testid="rail-principal">
            {station.principalId ?? "—"}
          </dd>
          {#if station.principalId === null}
            <p class="mt-1 text-xs text-muted-foreground">
              No agent occupies this station, so nobody can dispatch it.
            </p>
          {/if}
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Credentials</dt>
          <dd data-testid="rail-credential-mode">{credentialMode}</dd>
        </div>
      </dl>

      <!--
        The §1 invariant, re-hosted unchanged. It renders nothing in bridge
        mode, and it re-reads its state from the hub on mount, so appearing
        here (rather than stacked above the conversation) costs nothing an
        operator was relying on — `waiting` is the hub's answer now, not a
        flag this component holds.
      -->
      <div class="mt-3 empty:hidden">
        <MatrixIdentityPanel station={{ id: station.id, matrixId: station.matrixId }} />
      </div>
    </section>

    <!-- ── Placement ────────────────────────────────────────────────────── -->
    <section class="border-t border-border pt-4" data-testid="rail-placement">
      <h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Placement
      </h2>
      <dl class="space-y-2">
        <div>
          <dt class="text-xs text-muted-foreground">Station key</dt>
          <dd class="font-mono break-all" data-testid="rail-station-key">{station.stationKey}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Node</dt>
          <dd class="truncate" title={node?.name ?? station.nodeId}>
            <a class="underline-offset-2 hover:underline" href="/nodes/{station.nodeId}">
              {node?.name ?? station.nodeId}
            </a>
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Harness</dt>
          <dd class="font-mono break-all">{station.harness}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Node agent</dt>
          <dd class="font-mono break-all" data-testid="rail-agent-version">
            {agentVersion ?? node?.agentVersion ?? "—"}
          </dd>
        </div>
      </dl>

      <!--
        Purpose is editable here rather than read-only: it was a card stacked
        above the conversation, and the point of moving it is that it stops
        being the first thing between an operator and the agent — not that it
        stops being changeable.
      -->
      {#if onSavePurpose}
        <div class="mt-3">
          <PurposeField id="station-purpose" value={station.purpose ?? null} onSave={onSavePurpose} />
        </div>
      {:else}
        <div class="mt-3">
          <p class="text-xs text-muted-foreground">Purpose</p>
          <p>{station.purpose ?? "—"}</p>
        </div>
      {/if}
    </section>

    <!-- ── Who may dispatch it ──────────────────────────────────────────── -->
    <section class="border-t border-border pt-4" data-testid="rail-dispatch">
      <h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Who may dispatch it
      </h2>
      {#if !admin}
        <p class="text-muted-foreground" data-testid="rail-grant-not-visible">
          Who may dispatch this agent is not visible to you — grants are readable
          by administrators.
        </p>
      {:else if station.principalId === null}
        <p class="text-muted-foreground">
          Nobody: this station has no agent in it. Assign one and its grants apply.
        </p>
      {:else if grants.phase === "loading" || grants.phase === "idle"}
        <p class="text-muted-foreground">Reading grants…</p>
      {:else if grants.phase === "error"}
        <p class="text-status-error" role="alert">{grants.message}</p>
      {:else if grants.holders.length === 0}
        <p class="text-muted-foreground">
          No principal has been granted this agent.
        </p>
      {:else}
        <ul class="space-y-1" data-testid="rail-dispatchers">
          {#each grants.holders as holder (holder)}
            <li class="font-mono break-all">{holder}</li>
          {/each}
        </ul>
      {/if}
      {#if admin && grants.phase === "loaded" && !grants.enforced}
        <!-- A grant shown without this reads as a fleet locked down while
             ENFORCE_CONTROL_PAIR is unset and nothing is checking anything. -->
        <p class="mt-2 text-xs text-muted-foreground">
          Nothing is enforcing grants on this hub yet.
        </p>
      {/if}
      {#if admin}
        <a class="mt-2 inline-block text-xs underline underline-offset-2" href="/admin/grants">
          Manage grants
        </a>
      {/if}
    </section>
  {/if}
</div>
