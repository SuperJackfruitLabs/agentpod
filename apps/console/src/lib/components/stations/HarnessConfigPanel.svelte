<script lang="ts">
  /**
   * Declared harness configuration — the read-only half (spec D13, Task 2 of
   * the 2026-10-05 plan). One row per registered setting with something
   * declared for this station: its scope and policy, the declared value and
   * which level it came from, this station's observed value, and its state.
   *
   * Read-only on purpose: Task 3 adds plan → review → apply. This component
   * never writes anything, and D4 binds here too — an `awaiting-restart` row
   * says plainly that agentpod will not restart the harness; the station
   * page's own restart control is reached only through the optional
   * `onRestart` callback, mirroring `PluginManagementPanel`.
   *
   * `ConfigObservation` (the contract type `getStationConfig` returns) does
   * not carry which LEVEL won a station's declaration — the hub's
   * `compare()` uses the level internally (station beats node beats fleet,
   * `resolveFor` in `apps/hub/src/services/harness-config.ts`) but drops it
   * before the row reaches the route. Rather than invent a contract field,
   * this panel derives the level itself from the already-shipped, unchanged
   * `GET /api/fleet/config/declared` route: a settingId named by a
   * station-filtered row won at station level; absent that, one named by a
   * node-filtered row won at node level; absent both, a settingId that still
   * has an observation must be fleet-level — `compare()` never reports a
   * setting nobody declared anywhere. See `listStationDeclaredConfig` /
   * `listNodeDeclaredConfig` in `$lib/api/harness-config.ts`.
   */
  import type { ConfigObservation, ConfigPlan, ConfigPolicy, ConfigReceipt, ConfigScope } from "@agentpod/contract";
  import * as api from "$lib/api/harness-config";
  import { ApiError } from "$lib/api/http-error";
  import { Button } from "$lib/components/ui/button";

  let { stationId, nodeId, onRestart }: { stationId: string; nodeId: string; onRestart?: () => void } = $props();

  type Level = "station" | "node" | "fleet" | null;

  interface Row {
    settingId: string;
    scope: ConfigScope | null;
    policy: ConfigPolicy | null;
    declared: unknown;
    level: Level;
    observed: unknown;
    state: ConfigObservation["state"];
    reason: string | null;
  }

  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let epoch = 0;

  // Every state the registry can report, each with its own label. A state
  // this map does not name falls to `label()`'s own fallback below — never
  // silently to "Matches". (Step 5 of the plan mutates this on purpose, to
  // prove the `unreadable` test catches exactly that regression.)
  const STATE_LABEL: Partial<Record<ConfigObservation["state"], string>> = {
    matches: "Matches",
    drifted: "Drifted",
    absent: "Absent",
    unreadable: "Unreadable",
    "out-of-scope": "Out of scope",
    "opted-out": "Opted out",
    "awaiting-restart": "Awaiting restart",
  };

  /**
   * A state with no entry above must never read as agreement — it is
   * reported as explicitly unrecognised, never as "Matches". Step 5 of the
   * plan proves this by temporarily making this fall back to "Matches"
   * instead: the `unreadable` test must then fail, because `unreadable` is
   * deliberately removed from `STATE_LABEL` for that mutation.
   */
  function label(state: ConfigObservation["state"]): string {
    return STATE_LABEL[state] ?? `Unrecognised state (${state})`;
  }

  /** Station-level beats node-level beats fleet-level — `resolveFor`'s own precedence, re-derived client-side. */
  function levelFor(
    settingId: string,
    stationDeclared: api.DeclaredConfigRow[],
    nodeDeclared: api.DeclaredConfigRow[],
  ): Level {
    if (stationDeclared.some((r) => r.settingId === settingId)) return "station";
    if (nodeDeclared.some((r) => r.settingId === settingId)) return "node";
    return "fleet";
  }

  function fmt(value: unknown): string {
    if (value === undefined || value === null) return "—";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  /**
   * The observed column's text. `unreadable` is checked explicitly and
   * first: the document could not be read, which must never look like the
   * key simply being absent (both would otherwise render "—").
   */
  function observedText(row: Row): string {
    if (row.state === "unreadable") return "Unreadable — the document could not be read";
    if (row.observed === undefined) return "Absent from the document";
    return fmt(row.observed);
  }

  const restartNeeded = $derived(rows.some((r) => r.state === "awaiting-restart"));

  // ─── Plan → review → apply (Task 3, spec D13) ──────────────────────────
  //
  // The panel is a reader and a reviewer; it invents no second apply path.
  // `plan` is what review sees — it is fetched once and never re-fetched to
  // perform the apply. `applyPlan()` below sends exactly `plan.operationId`
  // and `plan.planDigest` as captured off the plan it is DISPLAYING, the
  // same discipline `PluginManagementPanel`'s `apply()` uses at its line 77.
  // Re-deriving or re-fetching a digest at apply time would silently turn
  // "apply what I reviewed" into "apply whatever is current" — the thing
  // the digest exists to prevent.
  let writeBusy = $state<string | null>(null);
  let plan = $state<ConfigPlan | null>(null);
  let planRefusal = $state<{ code?: string; message: string } | null>(null);
  let receipt = $state<ConfigReceipt | null>(null);
  let applyStale = $state<string | null>(null);
  let applyError = $state<string | null>(null);
  let reloadTrigger = $state(0);

  const canApply = $derived(plan !== null && !plan.noOp && receipt?.phase !== "applied");

  function clearReview() {
    plan = null;
    planRefusal = null;
    receipt = null;
    applyStale = null;
    applyError = null;
  }

  /** Mirrors `PluginManagementPanel`'s `perform`: one in-flight gate so a double click cannot double-apply. */
  async function perform<T>(label: string, task: () => Promise<T>, accept: (result: T) => void, onError: (e: unknown) => void) {
    if (writeBusy) return;
    writeBusy = label;
    try {
      const result = await task();
      accept(result);
    } catch (e) {
      onError(e);
    } finally {
      writeBusy = null;
    }
  }

  function reviewChanges() {
    if (writeBusy) return;
    clearReview();
    const id = stationId;
    void perform(
      "Asking the hub for a plan",
      () => api.planStationConfig(id),
      (result) => {
        plan = result;
      },
      (e) => {
        planRefusal =
          e instanceof ApiError
            ? { code: e.code, message: e.message }
            : { message: e instanceof Error ? e.message : "Could not plan this station's configuration" };
      },
    );
  }

  /**
   * A conflict status (409) on apply is the hub's answer that the document
   * or the recorded plan changed since review — `PLAN_STALE` and
   * `PLAN_DIGEST_MISMATCH` both land here, and so does a 409 carrying
   * neither code (the apply route forwards the node's own `conflict` receipt
   * with no top-level `code`). Any of these means the SAME thing for this
   * panel: the plan on screen is no longer good enough to apply, and only an
   * explicit "Plan again" click may produce a new one. Never re-plan here.
   */
  function isStaleApply(e: unknown): boolean {
    if (!(e instanceof ApiError)) return false;
    if (e.code === "PLAN_STALE" || e.code === "PLAN_DIGEST_MISMATCH") return true;
    return e.status === 409;
  }

  function applyPlan() {
    if (writeBusy || !plan || plan.noOp || receipt?.phase === "applied") return;
    // Captured from the plan this panel is DISPLAYING right now — never
    // re-read from `plan` after this point, and never re-fetched from the
    // hub. This is the one line Task 3 exists to get right.
    const reviewed = plan;
    const id = stationId;
    void perform(
      "Applying the reviewed plan",
      () => api.applyStationConfig(id, reviewed.operationId, reviewed.planDigest),
      (result) => {
        receipt = result;
        if (result.phase === "applied") reloadTrigger++; // refresh the observed rows below
      },
      (e) => {
        if (isStaleApply(e)) {
          applyStale =
            "This station's configuration document changed since this plan was reviewed. Plan again to review the current document — nothing was written from the stale plan.";
        } else {
          applyError = e instanceof Error ? e.message : "Could not apply this plan";
        }
      },
    );
  }

  $effect(() => {
    const sid = stationId;
    const nid = nodeId;
    void reloadTrigger; // re-reading this re-runs the load after a successful apply
    const ticket = ++epoch;
    rows = [];
    error = null;
    loading = true;

    let levelUnavailable = false;
    void Promise.all([
      api.getStationConfig(sid),
      api.listConfigSettings().catch(() => ({ settings: [], unreachableNodes: [] })),
      api.listStationDeclaredConfig(sid).catch(() => {
        levelUnavailable = true;
        return [] as api.DeclaredConfigRow[];
      }),
      api.listNodeDeclaredConfig(nid).catch(() => {
        levelUnavailable = true;
        return [] as api.DeclaredConfigRow[];
      }),
    ])
      .then(([config, registry, stationDeclared, nodeDeclared]) => {
        if (ticket !== epoch) return;
        const settingById = new Map(registry.settings.map((s) => [s.id, s]));
        rows = config.observations.map((o) => {
          const known = settingById.get(o.settingId);
          return {
            settingId: o.settingId,
            scope: known?.scope ?? null,
            policy: known?.policy ?? null,
            declared: o.declared,
            level: levelUnavailable ? null : levelFor(o.settingId, stationDeclared, nodeDeclared),
            observed: o.observed,
            state: o.state,
            reason: o.reason ?? null,
          };
        });
      })
      .catch((e) => {
        if (ticket !== epoch) return;
        rows = [];
        error = e instanceof Error ? e.message : "Could not reach the station to read its configuration";
      })
      .finally(() => {
        if (ticket === epoch) loading = false;
      });

    return () => {
      epoch++;
    };
  });
</script>

<section aria-label="Harness configuration" aria-busy={loading} class="space-y-4 border-t p-4">
  <div>
    <h2 class="font-semibold">Declared configuration</h2>
    <p class="text-sm text-muted-foreground">
      Every registered setting declared for this station, compared against what its harness actually has. Apply is
      reviewed elsewhere; this reads only.
    </p>
  </div>

  {#if loading}
    <p role="status" class="text-sm text-muted-foreground">Reading declared configuration…</p>
  {:else if error}
    <p role="alert" class="text-sm text-destructive">Could not read this station's configuration: {error}</p>
  {:else if rows.length === 0}
    <p class="text-sm text-muted-foreground">No settings declared for this station.</p>
  {:else}
    {#if restartNeeded}
      <div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
        <p>
          One or more settings below are written but not yet in effect. <strong
            >agentpod will not restart the harness</strong
          > to apply them.
        </p>
        {#if onRestart}
          <Button size="sm" variant="outline" class="mt-2" onclick={onRestart}>Restart station…</Button>
        {:else}
          <p class="text-muted-foreground">Use this station's own restart control to apply them.</p>
        {/if}
      </div>
    {/if}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <caption class="sr-only"
          >Declared harness configuration, one row per registered setting with something declared for this station</caption
        >
        <thead class="border-b text-muted-foreground">
          <tr>
            <th class="p-2">Setting</th>
            <th class="p-2">Declared</th>
            <th class="p-2">Observed</th>
            <th class="p-2">State</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.settingId)}
            <tr class="border-b align-top">
              <th scope="row" class="p-2 font-normal">
                <span class="font-mono text-xs">{row.settingId}</span>
                <span class="block text-xs text-muted-foreground">{row.scope ?? "scope unknown"} · {row.policy ?? "policy unknown"}</span>
              </th>
              <td class="p-2">
                <span class="font-mono text-xs">{fmt(row.declared)}</span>
                <span class="block text-xs text-muted-foreground">{row.level ? `from the ${row.level} level` : "level unavailable"}</span
                >
              </td>
              <td class="p-2 font-mono text-xs">{observedText(row)}</td>
              <td class="p-2">
                <span class="font-medium">{label(row.state)}</span>
                {#if row.reason}<span class="block text-xs text-muted-foreground">{row.reason}</span>{/if}
                {#if row.state === "awaiting-restart"}
                  <span class="block text-xs text-muted-foreground">agentpod will not restart the harness.</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <section aria-label="Review and apply changes" class="space-y-3 rounded-md border p-3 text-sm">
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-semibold">Review and apply</h3>
        <Button size="sm" disabled={writeBusy !== null} onclick={reviewChanges}>
          {plan || planRefusal ? "Plan again" : "Review changes"}
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        Asks the hub for a plan over every setting declared for this station. Nothing is written until the plan
        below is applied, and apply always sends the digest of exactly the plan shown here.
      </p>
      {#if writeBusy}<p role="status">{writeBusy}…</p>{/if}
      {#if planRefusal}
        <p role="alert" class="text-destructive">
          Refused ({planRefusal.code ?? "unrecognised code"}): {planRefusal.message}
        </p>
      {/if}
      {#if applyError}<p role="alert" class="text-destructive">{applyError}</p>{/if}
      {#if applyStale}<p role="alert" class="text-destructive">{applyStale}</p>{/if}
      {#if plan}
        <div class="space-y-2">
          {#if plan.noOp}
            <p>Nothing to change: every planned setting already matches what is declared.</p>
          {:else}
            {#if plan.restartRequired && receipt?.phase !== "applied"}
              <p class="text-amber-700">
                Applying this plan will need a restart to take effect. <strong
                  >agentpod will not restart the harness.</strong
                >
              </p>
            {/if}
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <caption class="sr-only">Planned changes for this station's configuration</caption>
                <thead class="border-b text-muted-foreground">
                  <tr>
                    <th class="p-1">Setting</th>
                    <th class="p-1">File</th>
                    <th class="p-1">Current → intended</th>
                    <th class="p-1">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {#each plan.entries as entry (entry.settingId)}
                    <tr class="border-b align-top">
                      <td class="p-1 font-mono">{entry.settingId}</td>
                      <td class="p-1 font-mono">{entry.file}:{entry.keyPath}</td>
                      <td class="p-1 font-mono">{fmt(entry.current)} → {fmt(entry.intended)}</td>
                      <td class="p-1">{entry.action}{entry.restartToTakeEffect ? " (needs a restart)" : ""}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <pre
              aria-label="Planned configuration change"
              class="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs">{plan.diff}</pre>
            {#if plan.diffTruncated}<p class="text-xs text-muted-foreground">The change is longer than shown.</p>{/if}
          {/if}
          <details>
            <summary class="cursor-pointer">Review identifiers</summary>
            <dl class="mt-2 space-y-1 break-all font-mono text-xs">
              <div><dt>Operation</dt><dd>{plan.operationId}</dd></div>
              <div><dt>Reviewed plan digest</dt><dd>{plan.planDigest}</dd></div>
            </dl>
          </details>
        </div>
        {#if receipt?.phase === "applied"}
          <p>
            Applied.
            {#if plan.restartRequired}
              This is written but not yet in effect. <strong>agentpod will not restart the harness</strong> — the row
              above now reads awaiting-restart.
            {/if}
          </p>
          {#if plan.restartRequired && onRestart}
            <Button size="sm" variant="outline" onclick={onRestart}>Restart station…</Button>
          {/if}
        {:else if canApply && !applyStale}
          <Button size="sm" disabled={writeBusy !== null} onclick={applyPlan}>Apply reviewed plan</Button>
        {/if}
      {/if}
    </section>
  {/if}
</section>
