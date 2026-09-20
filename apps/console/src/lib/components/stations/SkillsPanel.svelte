<script lang="ts">
  import { skillsInventory, type SkillInventoryResult } from "$lib/api/client";
  import type { SkillObservation } from "@agentpod/contract";
  import { Button } from "$lib/components/ui/button";

  let { stationId }: { stationId: string } = $props();
  let report = $state<SkillInventoryResult | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let refresh = $state(0);
  const states = ["catalogued", "present", "eligible", "loaded", "exercised"] as const;
  const labels = { catalogued: "Catalogued", present: "Present", eligible: "Eligible", loaded: "Loaded", exercised: "Used" };
  const value = (observation: SkillObservation) => observation.value === null ? "Unknown" : observation.value ? "Yes" : "No";

  $effect(() => {
    const id = stationId;
    void refresh;
    let cancelled = false;
    report = null;
    error = null;
    loading = true;
    void skillsInventory(id).then((result) => {
      if (!cancelled) report = result;
    }).catch((e) => {
      if (!cancelled) error = e instanceof Error ? e.message : "Could not load skill inventory";
    }).finally(() => {
      if (!cancelled) loading = false;
    });
    return () => { cancelled = true; };
  });
</script>

<section class="space-y-4 p-4" aria-label="Skill inventory" aria-busy={loading}>
  <div class="flex items-start justify-between gap-4">
    <div>
      <h2 class="font-semibold">Skills</h2>
      <p class="text-sm text-muted-foreground">Files, availability and session use are separate observations.</p>
    </div>
    <Button variant="outline" size="sm" disabled={loading} onclick={() => refresh++}>Refresh</Button>
  </div>
  {#if loading}
    <p role="status" class="text-sm text-muted-foreground">Reading skill inventory…</p>
  {:else if error}
    <p role="alert" class="text-sm text-destructive">{error}</p>
  {:else if report}
    <div class="rounded-md border p-3 text-sm">
      <p class="font-medium">{report.coverage.complete ? "Inventory observed" : "Partial inventory"}</p>
      <p class="text-muted-foreground">Observed {report.observedAt}. A present file does not establish that this session loaded or used it.</p>
      {#each report.coverage.limitations as limitation}
        <p class="mt-1 text-muted-foreground">{limitation}</p>
      {/each}
    </div>
    {#if report.skills.length === 0}
      <p class="text-sm text-muted-foreground">No skills observed in the scanned roots.</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <caption class="sr-only">Skill observations; unknown means no evidence was reported</caption>
          <thead class="border-b text-muted-foreground">
            <tr><th class="p-2">Skill</th>{#each states as state}<th class="p-2">{labels[state]}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each report.skills as skill (skill.id)}
              <tr class="border-b align-top">
                <th scope="row" class="p-2 font-normal">
                  <span class="font-medium">{skill.name}</span>
                  <span class="block text-xs text-muted-foreground">{skill.scope}</span>
                  <details class="mt-1 max-w-xl font-normal">
                    <summary class="cursor-pointer text-xs">Details</summary>
                    <p class="mt-2">{skill.description}</p>
                    <dl class="mt-2 space-y-1 break-all text-xs text-muted-foreground">
                      <div><dt class="mr-1 inline font-medium">Observed path: </dt><dd class="inline">{skill.path}</dd></div>
                      <div><dt class="mr-1 inline font-medium">Effective path: </dt><dd class="inline">{skill.effectivePath ?? "Unknown"}</dd></div>
                      <div><dt class="mr-1 inline font-medium">Source: </dt><dd class="inline">{skill.source.locator ?? skill.source.kind}</dd></div>
                      <div><dt class="mr-1 inline font-medium">Revision: </dt><dd class="inline">{skill.source.revision ?? "Unknown"}</dd></div>
                      <div><dt class="mr-1 inline font-medium">Package digest: </dt><dd class="inline">{skill.source.artifactDigest ?? "Unknown"}</dd></div>
                      <div><dt class="mr-1 inline font-medium">Entrypoint digest: </dt><dd class="inline">{skill.entrypointDigest ?? "Unknown"}</dd></div>
                      <div><dt class="mr-1 inline font-medium">Precedence: </dt><dd class="inline">{skill.shadowing.status}{skill.shadowing.by ? ` (${skill.shadowing.by})` : ""}</dd></div>
                    </dl>
                    {#if skill.shadowing.candidates.length}
                      <p class="mt-2 text-xs">Other entries with this name: {skill.shadowing.candidates.join(", ")}</p>
                    {/if}
                    <p class="mt-2 text-xs">Dependencies: {skill.dependencies.known ? (skill.dependencies.items.length ? "Listed below" : "None declared") : "Not established"}</p>
                    {#each skill.dependencies.items as dependency}
                      <p class="text-xs">{dependency.name} ({dependency.kind}): {value(dependency.available)} — {dependency.available.reason}</p>
                    {/each}
                    <p class="mt-2 text-xs">Compatibility: {skill.compatibility.length ? "Evidence below" : "Not established"}</p>
                    {#each skill.compatibility as check}
                      <p class="text-xs">{check.harness} {check.version}, {check.mode}: {value(check.result)} — {check.result.reason} ({check.evidenceRef})</p>
                    {/each}
                    {#each states as state}
                      <p class="mt-1 text-xs">{labels[state]}: {value(skill.evidence[state])} — {skill.evidence[state].reason}{skill.evidence[state].observedAt ? ` (${skill.evidence[state].observedAt})` : ""}</p>
                    {/each}
                  </details>
                </th>
                {#each states as state}
                  <td class="p-2" title={skill.evidence[state].reason}>{value(skill.evidence[state])}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <section aria-label="Native plugins" class="space-y-2">
      <h3 class="font-medium">Native plugins</h3>
      {#if report.plugins.length === 0}
        <p class="text-sm text-muted-foreground">No plugins observed by this scan. See coverage for what was inspected.</p>
      {/if}
      {#each report.plugins as plugin (plugin.id)}
        <div class="rounded-md border p-3 text-sm">
          <p class="font-medium">{plugin.name}</p>
          <p class="break-all text-muted-foreground">{plugin.path} · {plugin.scope}</p>
          <p>Components: {plugin.components.join(", ") || "Not reported"}</p>
          <p>Activation: {value(plugin.activation)} — {plugin.activation.reason}</p>
          {#each states as state}<p>{labels[state]}: {value(plugin.evidence[state])}</p>{/each}
        </div>
      {/each}
    </section>
    <details class="text-sm">
      <summary class="cursor-pointer font-medium">Scan coverage</summary>
      <ul class="mt-2 space-y-1 break-all text-muted-foreground">
        {#each report.coverage.roots as root}<li>{root.path} ({root.scope}): {root.status}</li>{/each}
      </ul>
      {#each report.issues as issue}
        <p class="mt-2 break-all">{issue.path}: {issue.reason}</p>
      {/each}
    </details>
  {/if}
</section>
