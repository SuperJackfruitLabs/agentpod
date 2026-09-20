<script lang="ts">
  import type { SkillArtifactMetadata, SkillHubOperation, SkillHubOperationSummary } from "@agentpod/contract";
  import * as api from "$lib/api/skills";
  import { Button } from "$lib/components/ui/button";

  let { stationId, harness, canManage }: { stationId: string; harness: string; canManage: boolean } = $props();
  let artifacts = $state<SkillArtifactMetadata[]>([]);
  let history = $state<SkillHubOperationSummary[]>([]);
  let operation = $state<SkillHubOperation | null>(null);
  let verification = $state<Awaited<ReturnType<typeof api.verifySkillFiles>> | null>(null);
  let artifactId = $state("");
  let profile = $state("");
  let file = $state<File | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let pending = $state<{ action: "install" | "rollback"; value: string; requestId: string } | null>(null);
  let epoch = 0;
  const eligible = $derived(artifacts.filter(artifact => artifact.harness === harness));
  const locked = $derived(busy !== null || !canManage);
  const validProfile = $derived(profile.length <= 124 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile));
  const labels: Record<SkillHubOperation["state"], string> = {
    requested: "Requested", planning: "Preparing plan", planned: "Ready for review",
    applying: "Applying files", applied: "Files applied", unknown: "Outcome unknown", conflict: "Conflict",
  };

  $effect(() => {
    const id = stationId;
    void harness;
    const ticket = ++epoch;
    artifacts = []; history = []; operation = null; verification = null;
    artifactId = ""; profile = ""; file = null; pending = null; error = null; busy = "Loading management data";
    void Promise.all([api.listSkillArtifacts(), api.listSkillOperations(id)]).then(([packages, operations]) => {
      if (ticket !== epoch) return;
      artifacts = packages; history = operations;
    }).catch(e => {
      if (ticket === epoch) error = e instanceof Error ? e.message : "Could not load management data";
    }).finally(() => { if (ticket === epoch) busy = null; });
    return () => { epoch++; };
  });

  async function perform<T>(label: string, task: () => Promise<T>, accept: (result: T) => void, uncertain = false) {
    if (busy) return;
    const ticket = epoch;
    busy = label; error = null;
    try {
      const result = await task();
      if (ticket === epoch) accept(result);
    } catch (e) {
      if (ticket !== epoch) return;
      error = e instanceof Error ? e.message : "Request failed";
      if (uncertain && operation) operation = { ...operation, state: "unknown", inFlight: false };
    } finally { if (ticket === epoch) busy = null; }
  }
  function show(result: SkillHubOperation) {
    operation = result; verification = null;
    history = [result, ...history.filter(item => item.id !== result.id)].slice(0, 50);
  }
  function plan(action: "install" | "rollback") {
    if (locked || (action === "install" ? !artifactId : !validProfile)) return;
    pending = { action, value: action === "install" ? artifactId : profile, requestId: crypto.randomUUID() };
    operation = null; verification = null;
    retryPlanning();
  }
  function retryPlanning() {
    if (locked || !pending) return;
    const request = pending, id = stationId;
    void perform("Preparing plan", () => request.action === "install"
      ? api.planSkillInstall(id, request.value, request.requestId)
      : api.planSkillRollback(id, request.value, request.requestId), result => { pending = null; show(result); });
  }
  function apply() {
    if (locked || !operation?.plan || operation.state !== "planned" || operation.inFlight) return;
    const reviewed = operation, id = stationId;
    verification = null;
    void perform("Applying reviewed plan", () => api.applySkillOperation(id, reviewed.id, reviewed.plan!.planDigest), show, true);
  }
  function inspect() {
    if (!operation) return;
    const id = stationId, operationId = operation.id;
    void perform("Inspecting node outcome", () => api.inspectSkillOperation(id, operationId), show);
  }
  function verify() {
    if (!operation) return;
    const id = stationId, selectedProfile = operation.profile;
    verification = null;
    void perform("Verifying installed files", () => api.verifySkillFiles(id, selectedProfile), result => { verification = result; });
  }
  function upload() {
    if (locked || !file || !validProfile) return;
    const archive = file, targetHarness = harness, targetProfile = profile;
    void perform("Uploading artifact", () => api.uploadSkillArtifact(archive, targetHarness, targetProfile), result => {
      artifacts = [result, ...artifacts.filter(item => item.id !== result.id)]; artifactId = result.id;
    });
  }
  function refresh() {
    const id = stationId;
    void perform("Refreshing history", () => Promise.all([api.listSkillArtifacts(), api.listSkillOperations(id)]), ([packages, operations]) => {
      artifacts = packages; history = operations;
    });
  }
</script>

<section aria-label="Skill management" aria-busy={busy !== null} class="space-y-4 border-t p-4">
  <div class="flex items-start justify-between gap-4">
    <div><h2 class="font-semibold">Manage skills</h2><p class="text-sm text-muted-foreground">Review file changes before applying an artifact to this station.</p></div>
    <Button variant="outline" size="sm" disabled={busy !== null} onclick={refresh}>Refresh history</Button>
  </div>
  {#if !canManage}<p class="text-sm text-muted-foreground">Permission to change this station is required to install or roll back skills.</p>{/if}
  {#if busy}<p role="status" class="text-sm">{busy}…</p>{/if}
  {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
  <div class="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
    <div class="space-y-2">
      <label class="block text-sm font-medium" for="skill-artifact">Artifact</label>
      <select id="skill-artifact" class="w-full rounded-md border bg-background p-2 text-sm" bind:value={artifactId} disabled={locked || pending !== null}>
        <option value="">Select an artifact for {harness}</option>
        {#each eligible as artifact (artifact.id)}<option value={artifact.id}>{artifact.profile} · {artifact.archiveSHA256.slice(0, 12)}</option>{/each}
      </select>
      <p class="text-xs text-muted-foreground">Upload metadata is unverified. The node checks the package while preparing its plan; native compatibility remains separate.</p>
      <Button size="sm" disabled={locked || !artifactId || pending !== null} onclick={() => plan("install")}>Review installation</Button>
    </div>
    <div class="space-y-2">
      <label class="block text-sm font-medium" for="skill-profile">Profile</label>
      <input id="skill-profile" class="w-full rounded-md border bg-background p-2 text-sm" bind:value={profile} placeholder="engineering-core" maxlength="124" disabled={locked || pending !== null} />
      <p class="text-xs text-muted-foreground">Use the profile named in the exported artifact, or an installed profile to restore its previous revision.</p>
      <Button size="sm" variant="outline" disabled={locked || !validProfile || pending !== null} onclick={() => plan("rollback")}>Review rollback</Button>
      <details class="text-sm">
        <summary class="cursor-pointer">Upload an exported artifact</summary>
        <label class="mt-2 block" for="skill-file">Archive (up to 32 MiB)</label>
        <input id="skill-file" class="my-2 block max-w-full text-xs" type="file" accept=".tar.gz,.tgz" disabled={locked} onchange={event => { file = event.currentTarget.files?.[0] ?? null; }} />
        <Button size="sm" variant="outline" disabled={locked || !file || !validProfile || pending !== null} onclick={upload}>Upload artifact</Button>
      </details>
    </div>
  </div>
  {#if pending}
    <div class="space-y-2 rounded-md border p-3 text-sm">
      <p>Planning has not returned a confirmed result. Retry the same request or refresh history to find its operation.</p>
      <Button size="sm" disabled={locked} onclick={retryPlanning}>Retry planning</Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => { pending = null; }}>Start another plan</Button>
    </div>
  {/if}
  {#if operation}
    <section aria-label="Reviewed operation" class="space-y-3 rounded-md border p-3 text-sm">
      <div><h3 class="font-semibold">{labels[operation.state]}</h3><p class="text-muted-foreground">{operation.action === "install" ? "Installation" : "Rollback"} · {operation.profile} · {operation.harness}</p></div>
      {#if operation.inFlight}<p role="status">The hub is processing this operation. Inspect again for its latest outcome.</p>{/if}
      {#if operation.error}<p class="text-destructive">{operation.error}</p>{/if}
      {#if operation.state === "unknown"}<p>Completion is unconfirmed. Inspect the node before deciding whether to retry.</p>{/if}
      {#if operation.state === "conflict"}<p>Existing files or state differ from the reviewed plan. Preserve local edits, inspect the station, then prepare a new plan after resolving the conflict.</p>{/if}
      {#if operation.plan}
        <p class="break-all">Workspace: {operation.plan.binding.workspacePath}</p>
        <p class="break-all">Destination: {operation.plan.targetPath ?? "No managed revision selected after rollback"}</p>
        <p>Activation pending. Applying files does not establish that the harness loaded them or restart an active session.</p>
        <div class="grid gap-3 sm:grid-cols-3">
          {#each ["added", "changed", "removed"] as kind}
            <div><h4 class="font-medium capitalize">{kind} ({operation.plan.changes[kind as "added" | "changed" | "removed"].length})</h4>
              <ul class="mt-1 max-h-48 space-y-1 overflow-auto break-all font-mono text-xs">
                {#each operation.plan.changes[kind as "added" | "changed" | "removed"] as path}<li>{path}</li>{/each}
              </ul>
            </div>
          {/each}
        </div>
        <details><summary class="cursor-pointer">Revision and review identifiers</summary>
          <dl class="mt-2 space-y-1 break-all font-mono text-xs">
            <div><dt>Operation</dt><dd>{operation.id}</dd></div>
            <div><dt>Previous archive</dt><dd>{operation.plan.before?.archiveSHA256 ?? "None"}</dd></div>
            <div><dt>Selected archive</dt><dd>{operation.plan.after?.archiveSHA256 ?? "None"}</dd></div>
            <div><dt>Reviewed plan</dt><dd>{operation.plan.planDigest}</dd></div>
          </dl>
        </details>
      {/if}
      <div class="flex flex-wrap gap-2">
        {#if operation.state === "planned" && operation.plan && !operation.inFlight}<Button size="sm" disabled={locked} onclick={apply}>Apply reviewed plan</Button>{/if}
        <Button size="sm" variant="outline" disabled={busy !== null} onclick={inspect}>Inspect node outcome</Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onclick={verify}>Verify files</Button>
      </div>
      {#if verification}
        <div class="space-y-1 border-t pt-2">
          <p>Files present: {verification.verification.present.value === null ? "Unknown" : verification.verification.present.value ? "Yes" : "No"} — {verification.verification.present.reason}</p>
          <p>Loaded: {verification.verification.loaded.value === null ? "Unknown" : verification.verification.loaded.value ? "Yes" : "No"} — {verification.verification.loaded.reason}</p>
        </div>
      {/if}
    </section>
  {/if}
  <section aria-label="Operation history" class="space-y-2 text-sm">
    <h3 class="font-medium">Recent operations</h3>
    {#if history.length === 0}<p class="text-muted-foreground">No recorded operations in this view.</p>{/if}
    <ul class="space-y-2">
      {#each history as item (item.id)}
        <li class="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
          <div><p>{item.profile} · {item.action} · {labels[item.state]}</p><p class="text-xs text-muted-foreground">{item.createdAt}</p></div>
          <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => {
            const id = stationId;
            void perform("Loading operation", () => api.getSkillOperation(id, item.id), show);
          }}>Open operation</Button>
        </li>
      {/each}
    </ul>
  </section>
</section>
