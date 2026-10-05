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
  import type { ConfigObservation, ConfigPolicy, ConfigScope } from "@agentpod/contract";
  import * as api from "$lib/api/harness-config";
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

  $effect(() => {
    const sid = stationId;
    const nid = nodeId;
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
  {/if}
</section>
