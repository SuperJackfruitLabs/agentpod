<script lang="ts">
  import { TrustedSkillReleaseRecord, type SkillArtifactMetadata, type SkillHubOperation, type SkillHubOperationSummary, type TrustedSkillReleaseMetadata, type SkillReleaseCohortMetadata } from "@agentpod/contract";
  import * as api from "$lib/api/skills";
  import { Button } from "$lib/components/ui/button";

  let { stationId, harness, canManage, canNative = false }: { stationId: string; harness: string; canManage: boolean; canNative?: boolean } = $props();
  let artifacts = $state<SkillArtifactMetadata[]>([]);
  let releases = $state<TrustedSkillReleaseMetadata[]>([]);
  let cohorts = $state<SkillReleaseCohortMetadata[]>([]);
  let history = $state<SkillHubOperationSummary[]>([]);
  let nativeHistory = $state<SkillHubOperationSummary[]>([]);
  let operation = $state<SkillHubOperation | null>(null);
  let verification = $state<Awaited<ReturnType<typeof api.verifySkillFiles>> | null>(null);
  let retention = $state<Awaited<ReturnType<typeof api.inspectSkillRetention>> | null>(null);
  let maintenance = $state<Awaited<ReturnType<typeof api.planSkillMaintenance>> | null>(null);
  let artifactId = $state("");
  let releaseId = $state("");
  let cohortId = $state("");
  let profile = $state("");
  let file = $state<File | null>(null);
  let releaseRecord = $state("");
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let pending = $state<{ action: "install" | "rollback"; value: string; requestId: string } | null>(null);
  let nativePending = $state<{ action: "activate" | "deactivate" | "rollback"; requestId: string } | null>(null);
  let epoch = 0;
  const eligible = $derived(artifacts.filter(artifact => artifact.harness === harness));
  const selectedRelease = $derived(releases.find(release => release.id === releaseId) ?? null);
  const selectedCohort = $derived(cohorts.find(cohort => cohort.id === cohortId) ?? null);
  const locked = $derived(busy !== null || !canManage);
  const nativeLocked = $derived(busy !== null || !canNative);
  const validProfile = $derived(profile.length <= 124 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile));
  const labels: Record<SkillHubOperation["state"], string> = {
    requested: "Requested", planning: "Preparing plan", planned: "Ready for review",
    applying: "Applying files", applied: "Files applied", unknown: "Outcome unknown", conflict: "Conflict",
  };

  $effect(() => {
    const id = stationId;
    void harness;
    const ticket = ++epoch;
    artifacts = []; releases = []; cohorts = []; history = []; nativeHistory = []; operation = null; verification = null; retention = null; maintenance = null;
    artifactId = ""; releaseId = ""; cohortId = ""; profile = ""; file = null; pending = null; nativePending = null; error = null; busy = "Loading management data";
    void Promise.all([canManage ? api.listSkillArtifacts() : Promise.resolve([]), canManage ? api.listTrustedSkillReleases() : Promise.resolve([]), canManage ? api.listSkillReleaseCohorts() : Promise.resolve([]), canManage ? api.listSkillOperations(id) : Promise.resolve([]), canNative ? api.listNativeSkillOperations(id) : Promise.resolve([])]).then(([packages, trustedReleases, releaseCohorts, operations, nativeOperations]) => {
      if (ticket !== epoch) return;
      artifacts = packages; releases = trustedReleases; cohorts = releaseCohorts; history = operations; nativeHistory = nativeOperations;
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
    if (result.kind === "native") nativeHistory = [result, ...nativeHistory.filter(item => item.id !== result.id)].slice(0, 50);
    else history = [result, ...history.filter(item => item.id !== result.id)].slice(0, 50);
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
    void perform("Applying reviewed plan", () => reviewed.kind === "native" ? api.applyNativeSkillOperation(id, reviewed.id, reviewed.plan!.planDigest) : api.applySkillOperation(id, reviewed.id, reviewed.plan!.planDigest), show, true);
  }
  function inspect() {
    if (!operation) return;
    const id = stationId, operationId = operation.id;
    void perform("Inspecting node outcome", () => operation!.kind === "native" ? api.inspectNativeSkillOperation(id, operationId) : api.inspectSkillOperation(id, operationId), show);
  }
  function verify() {
    if (!operation) return;
    const id = stationId, selectedProfile = operation.profile;
    verification = null;
    void perform("Verifying installed files", () => operation!.kind === "native" ? api.verifyNativeSkillPlacement(id, selectedProfile) : api.verifySkillFiles(id, selectedProfile), result => { verification = result; });
  }
  function inspectRetention() {
    if (locked || !validProfile) return;
    const id = stationId, selectedProfile = profile;
    void perform("Inspecting retained skill state", () => api.inspectSkillRetention(id, selectedProfile), result => { retention = result; });
  }
  function previewMaintenance() {
    if (locked || !validProfile) return;
    const id = stationId, selectedProfile = profile;
    void perform("Preparing retained-state maintenance preview", () => api.planSkillMaintenance(id, selectedProfile), result => { maintenance = result; });
  }
  function applyMaintenance() {
    if (locked || !maintenance || maintenance.maintenance.preview.generations.length + maintenance.maintenance.preview.operations.length + maintenance.maintenance.preview.nativeOperations.length + maintenance.maintenance.preview.nativeBackups.length === 0) return;
    const reviewed = maintenance, id = stationId;
    void perform("Applying reviewed retained-state cleanup", () => api.applySkillMaintenance(id, reviewed.profile, reviewed.maintenance.planDigest), result => { maintenance = result; retention = null; });
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
    void perform("Refreshing history", () => Promise.all([canManage ? api.listSkillArtifacts() : Promise.resolve([]), canManage ? api.listTrustedSkillReleases() : Promise.resolve([]), canManage ? api.listSkillReleaseCohorts() : Promise.resolve([]), canManage ? api.listSkillOperations(id) : Promise.resolve([]), canNative ? api.listNativeSkillOperations(id) : Promise.resolve([])]), ([packages, trustedReleases, releaseCohorts, operations, nativeOperations]) => {
      artifacts = packages; releases = trustedReleases; cohorts = releaseCohorts; history = operations; nativeHistory = nativeOperations;
    });
  }
  function createCanaryCohort() {
    if (locked || !selectedRelease) return;
    const release = selectedRelease;
    void perform("Creating explicit canary cohort", () => api.createSkillReleaseCohort(release.id, release.recordDigest, [stationId]), result => {
      cohorts = [result, ...cohorts.filter(cohort => cohort.id !== result.id)]; cohortId = result.id;
    });
  }
  function importRelease() {
    if (locked || !releaseRecord.trim()) return;
    let record: TrustedSkillReleaseRecord;
    try { record = TrustedSkillReleaseRecord.parse(JSON.parse(releaseRecord)); }
    catch { error = "Release record must be valid canonical release JSON."; return; }
    const pins = record.artifacts.map(expected => {
      const artifact = artifacts.find(candidate => candidate.harness === expected.harness && candidate.profile === record.profile && candidate.archiveSHA256 === expected.archive_sha256);
      return artifact ? { harness: expected.harness, artifactId: artifact.id } : null;
    });
    if (pins.some(pin => pin === null)) { error = "Upload each archive named by this release record before recording it."; return; }
    void perform("Recording trusted release", () => api.importTrustedSkillRelease(record, pins as { harness: TrustedSkillReleaseRecord["artifacts"][number]["harness"]; artifactId: string }[]), result => {
      releases = [result, ...releases.filter(release => release.id !== result.id)]; releaseId = result.id; releaseRecord = "";
    });
  }
  function planCanary() {
    if (locked || !selectedCohort || !selectedRelease || !selectedCohort.stationIds.includes(stationId)) return;
    const cohort = selectedCohort, release = selectedRelease;
    void perform("Preparing trusted release canary", () => api.planSkillReleaseCanary(cohort.id, release.id, release.recordDigest, stationId, crypto.randomUUID()), result => show(result.operation));
  }
  function planNative(action: "activate" | "deactivate" | "rollback") {
    if (nativeLocked || !validProfile) return;
    nativePending = { action, requestId: crypto.randomUUID() }; operation = null; verification = null;
    retryNativePlanning();
  }
  function retryNativePlanning() {
    if (nativeLocked || !nativePending) return;
    const request = nativePending, id = stationId, selectedProfile = profile;
    void perform("Preparing native placement", () => api.planNativeSkillPlacement(id, selectedProfile, request.action, request.requestId), result => { nativePending = null; show(result); });
  }
</script>

<section aria-label="Skill management" aria-busy={busy !== null} class="space-y-4 border-t p-4">
  <div class="flex items-start justify-between gap-4">
    <div><h2 class="font-semibold">Manage skills</h2><p class="text-sm text-muted-foreground">Review file changes before applying an artifact to this station.</p></div>
    <Button variant="outline" size="sm" disabled={busy !== null} onclick={refresh}>Refresh history</Button>
  </div>
  {#if canNative}
    <div class="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <h3 class="font-medium">Native placement</h3>
      <p class="text-muted-foreground">Places the selected managed profile in this harness’s native skill directory. It requires a quiescent project, never restarts the agent, and can remain loading-unknown after publication.</p>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" disabled={nativeLocked || !validProfile || nativePending !== null} onclick={() => planNative("activate")}>Review native activation</Button>
        <Button size="sm" variant="outline" disabled={nativeLocked || !validProfile || nativePending !== null} onclick={() => planNative("rollback")}>Review native rollback</Button>
        <Button size="sm" variant="outline" disabled={nativeLocked || !validProfile || nativePending !== null} onclick={() => planNative("deactivate")}>Review native removal</Button>
      </div>
      {#if nativePending}<p>Planning has not returned a confirmed result. <button class="underline" disabled={nativeLocked} onclick={retryNativePlanning}>Retry native planning</button></p>{/if}
    </div>
  {/if}
  {#if !canManage}<p class="text-sm text-muted-foreground">Permission to change this station is required to install or roll back skills.</p>{/if}
  {#if busy}<p role="status" class="text-sm">{busy}…</p>{/if}
  {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
  {#if canManage}
    <section aria-label="Trusted release canary" class="space-y-2 rounded-md border border-primary/30 p-3 text-sm">
      <h3 class="font-medium">Trusted release canary</h3>
      <p class="text-muted-foreground">A canary is one explicit station in an immutable cohort. Its reviewed plan does not advance any other station.</p>
      <label class="block" for="trusted-release">Trusted release</label>
      <select id="trusted-release" class="w-full rounded-md border bg-background p-2 text-sm" bind:value={releaseId} disabled={locked}>
        <option value="">Select a recorded release</option>
        {#each releases as release (release.id)}<option value={release.id}>{release.version} · {release.profile} · {release.recordDigest.slice(0, 12)}</option>{/each}
      </select>
      {#if releases.length === 0}<p class="text-xs text-muted-foreground">No trusted release records are available for this account.</p>{/if}
      <details class="text-xs text-muted-foreground">
        <summary class="cursor-pointer">Record a complete trusted release</summary>
        <p class="mt-2">Paste the signed-off release JSON. AgentPod matches every pinned archive by harness, profile and checksum before recording it.</p>
        <textarea aria-label="Trusted release record" class="mt-2 min-h-32 w-full rounded-md border bg-background p-2 font-mono text-xs" bind:value={releaseRecord} disabled={locked} placeholder={'{"schema_version":1, ...}'}></textarea>
        <Button size="sm" variant="outline" class="mt-2" disabled={locked || !releaseRecord.trim()} onclick={importRelease}>Record trusted release</Button>
      </details>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={locked || !selectedRelease} onclick={createCanaryCohort}>Enroll this station as canary</Button>
        <select aria-label="Canary cohort" class="rounded-md border bg-background p-2 text-sm" bind:value={cohortId} disabled={locked}>
          <option value="">Select a cohort</option>
          {#each cohorts.filter(cohort => cohort.releaseId === selectedRelease?.id && cohort.stationIds.includes(stationId)) as cohort (cohort.id)}<option value={cohort.id}>{cohort.id.slice(0, 12)} · {cohort.stationIds.length} station{cohort.stationIds.length === 1 ? "" : "s"}</option>{/each}
        </select>
        <Button size="sm" disabled={locked || !selectedRelease || !selectedCohort || !selectedCohort.stationIds.includes(stationId)} onclick={planCanary}>Review canary plan</Button>
      </div>
    </section>
  {/if}
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
      <Button size="sm" variant="outline" disabled={locked || !validProfile || pending !== null} onclick={inspectRetention}>Inspect retained state</Button>
      <Button size="sm" variant="outline" disabled={locked || !validProfile || pending !== null} onclick={previewMaintenance}>Preview safe cleanup</Button>
      <details class="text-sm">
        <summary class="cursor-pointer">Upload an exported artifact</summary>
        <label class="mt-2 block" for="skill-file">Archive (up to 32 MiB)</label>
        <input id="skill-file" class="my-2 block max-w-full text-xs" type="file" accept=".tar.gz,.tgz" disabled={locked} onchange={event => { file = event.currentTarget.files?.[0] ?? null; }} />
        <Button size="sm" variant="outline" disabled={locked || !file || !validProfile || pending !== null} onclick={upload}>Upload artifact</Button>
      </details>
    </div>
  </div>
  {#if retention}
    <section aria-label="Retained skill state" class="space-y-2 rounded-md border p-3 text-sm">
      <h3 class="font-semibold">Retained state for {retention.profile}</h3>
      {#if !retention.retention.namespaceExists}
        <p>No managed namespace exists. Inspection did not create one.</p>
      {:else}
        <p>Operations: {retention.retention.operations} of {retention.retention.operationLimit}; generations: {retention.retention.generations}; staging records: {retention.retention.staging}; interrupted writes: {retention.retention.pending}.</p>
        <p>Native records: {retention.retention.nativeOperations} operations, {retention.retention.nativeStaging} staging copies, {retention.retention.nativeBackups} backups.</p>
      {/if}
      <p class="text-xs text-muted-foreground">{retention.retention.limitation}</p>
    </section>
  {/if}
  {#if maintenance}
    <section aria-label="Safe retained-state cleanup preview" class="space-y-2 rounded-md border p-3 text-sm">
      <h3 class="font-semibold">Safe cleanup preview for {maintenance.profile}</h3>
      <p>Unreferenced generations: {maintenance.maintenance.preview.generations.length}; completed managed records: {maintenance.maintenance.preview.operations.length}; completed native records: {maintenance.maintenance.preview.nativeOperations.length}; native backups: {maintenance.maintenance.preview.nativeBackups.length}.</p>
      <details><summary class="cursor-pointer">Review candidate identifiers</summary>
        <ul class="mt-2 max-h-40 overflow-auto break-all font-mono text-xs">
          {#each ["generations", "operations", "nativeOperations", "nativeBackups"] as kind}
            {#each maintenance.maintenance.preview[kind as "generations" | "operations" | "nativeOperations" | "nativeBackups"] as candidate}<li>{kind}: {candidate}</li>{/each}
          {/each}
        </ul>
      </details>
      <p class="text-xs text-muted-foreground">Review digest: {maintenance.maintenance.planDigest}</p>
      <p class="text-xs text-muted-foreground">{maintenance.maintenance.limitation}</p>
      {#if maintenance.maintenance.preview.generations.length + maintenance.maintenance.preview.operations.length + maintenance.maintenance.preview.nativeOperations.length + maintenance.maintenance.preview.nativeBackups.length > 0}
        <Button size="sm" variant="destructive" disabled={locked} onclick={applyMaintenance}>Apply reviewed cleanup</Button>
      {:else}<p class="text-xs text-muted-foreground">No safely removable retained state was found.</p>{/if}
    </section>
  {/if}
  {#if pending}
    <div class="space-y-2 rounded-md border p-3 text-sm">
      <p>Planning has not returned a confirmed result. Retry the same request or refresh history to find its operation.</p>
      <Button size="sm" disabled={locked} onclick={retryPlanning}>Retry planning</Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => { pending = null; }}>Start another plan</Button>
    </div>
  {/if}
  {#if operation}
    <section aria-label="Reviewed operation" class="space-y-3 rounded-md border p-3 text-sm">
      <div><h3 class="font-semibold">{labels[operation.state]}</h3><p class="text-muted-foreground">{operation.kind === "native" ? `Native ${operation.action}` : operation.action === "install" ? "Installation" : "Rollback"} · {operation.profile} · {operation.harness}</p></div>
      {#if operation.inFlight}<p role="status">The hub is processing this operation. Inspect again for its latest outcome.</p>{/if}
      {#if operation.error}<p class="text-destructive">{operation.error}</p>{/if}
      {#if operation.state === "unknown"}<p>Completion is unconfirmed. Inspect the node before deciding whether to retry.</p>{/if}
      {#if operation.state === "conflict"}<p>Existing files or state differ from the reviewed plan. Preserve local edits, inspect the station, then prepare a new plan after resolving the conflict.</p>{/if}
      {#if operation.plan}
        <p class="break-all">Workspace: {operation.plan.binding.workspacePath}</p>
        <p class="break-all">Destination: {operation.plan.targetPath ?? "No managed revision selected after rollback"}</p>
        <p>{operation.kind === "native" ? "Native publication is reviewed and quiescent-only. It does not restart an active session." : "Activation pending. Applying files does not establish that the harness loaded them or restart an active session."}</p>
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
  {#if canNative}
    <section aria-label="Native placement history" class="space-y-2 text-sm">
      <h3 class="font-medium">Native placement history</h3>
      {#if nativeHistory.length === 0}<p class="text-muted-foreground">No recorded native placements.</p>{/if}
      <ul class="space-y-2">
        {#each nativeHistory as item (item.id)}
          <li class="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
            <div><p>{item.profile} · {item.action} · {labels[item.state]}</p><p class="text-xs text-muted-foreground">{item.createdAt}</p></div>
            <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => { const id = stationId; void perform("Loading native operation", () => api.getNativeSkillOperation(id, item.id), show); }}>Open native operation</Button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</section>
