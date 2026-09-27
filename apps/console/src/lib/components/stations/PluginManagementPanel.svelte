<script lang="ts">
  import type { PluginOperationPlan, SkillHubOperation, SkillHubOperationSummary } from "@agentpod/contract";
  import * as api from "$lib/api/plugins";
  import { Button } from "$lib/components/ui/button";

  // The node plans; this panel shows the plan, and applies exactly what was
  // reviewed, by its digest. Loading the plugin needs a gateway restart, which
  // stays a separate, confirmed station action (onRestart).
  let { stationId, canManage, onRestart }: { stationId: string; canManage: boolean; onRestart?: () => void } = $props();
  let history = $state<SkillHubOperationSummary[]>([]);
  let operation = $state<SkillHubOperation | null>(null);
  let pending = $state<{ action: "enable" | "disable"; requestId: string } | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let epoch = 0;
  const locked = $derived(busy !== null || !canManage);
  const plan = $derived.by((): PluginOperationPlan | null => {
    const candidate = operation?.plan ?? operation?.receipt?.plan ?? null;
    return candidate && "refusal" in candidate ? candidate : null;
  });
  const labels: Record<SkillHubOperation["state"], string> = {
    requested: "Requested", planning: "Preparing plan", planned: "Ready for review",
    applying: "Applying", applied: "Applied", unknown: "Outcome unknown", conflict: "Not applied",
  };
  const fileActions: Record<string, string> = {
    add: "Installs the plugin files",
    replace: "Replaces the plugin files; the old copy is kept in the profile's .agentpod backups",
    keep: "Leaves the installed plugin files as they are",
    adopt: "Adopts an identical hand-installed copy as managed",
    remove: "Removes the plugin files",
    none: "The plugin files are already gone",
  };

  $effect(() => {
    const id = stationId;
    const ticket = ++epoch;
    history = []; operation = null; pending = null; error = null; busy = "Loading plugin operations";
    void api.listPluginOperations(id).then((operations) => {
      if (ticket === epoch) history = operations;
    }).catch((e) => {
      if (ticket === epoch) error = e instanceof Error ? e.message : "Could not load plugin operations";
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
    operation = result;
    history = [result, ...history.filter((item) => item.id !== result.id)].slice(0, 50);
  }
  function review(action: "enable" | "disable") {
    if (locked) return;
    pending = { action, requestId: crypto.randomUUID() };
    operation = null;
    retryPlanning();
  }
  function retryPlanning() {
    if (locked || !pending) return;
    const request = pending, id = stationId;
    void perform("Asking the node for a plan", () => api.planPluginOperation(id, request.action, request.requestId), (result) => { pending = null; show(result); });
  }
  function apply() {
    if (locked || !operation || !plan || operation.state !== "planned" || operation.inFlight) return;
    const reviewed = operation, digest = plan.planDigest, id = stationId;
    void perform("Applying the reviewed plan", () => api.applyPluginOperation(id, reviewed.id, digest), show, true);
  }
  function inspect() {
    if (!operation) return;
    const id = stationId, operationId = operation.id;
    void perform("Inspecting the node's record", () => api.inspectPluginOperation(id, operationId), show);
  }
  function open(item: SkillHubOperationSummary) {
    const id = stationId;
    void perform("Loading operation", () => api.getPluginOperation(id, item.id), show);
  }
  function refresh() {
    const id = stationId;
    void perform("Refreshing history", () => api.listPluginOperations(id), (operations) => { history = operations; });
  }
</script>

<section aria-label="Plugin management" aria-busy={busy !== null} class="space-y-4 border-t p-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h2 class="font-semibold">Manage the agentpod-live plugin</h2>
      <p class="text-sm text-muted-foreground">Streams this Hermes agent's replies into AgentPod clients. The node plans each change against its own Hermes and profile; you review it before anything is written.</p>
    </div>
    <Button variant="outline" size="sm" disabled={busy !== null} onclick={refresh}>Refresh history</Button>
  </div>
  {#if canManage}
    <div class="flex flex-wrap gap-2">
      <Button size="sm" disabled={locked || pending !== null} onclick={() => review("enable")}>Review enable</Button>
      <Button size="sm" variant="outline" disabled={locked || pending !== null} onclick={() => review("disable")}>Review disable</Button>
    </div>
  {:else}
    <p class="text-sm text-muted-foreground">Permission to change this station is required to enable or disable plugins.</p>
  {/if}
  {#if busy}<p role="status" class="text-sm">{busy}…</p>{/if}
  {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
  {#if pending && !busy}
    <div class="space-y-2 rounded-md border p-3 text-sm">
      <p>Planning did not return a confirmed result. Retry the same request, or refresh history to find its operation.</p>
      <Button size="sm" disabled={locked} onclick={retryPlanning}>Retry planning</Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => { pending = null; }}>Start another plan</Button>
    </div>
  {/if}
  {#if operation}
    <section aria-label="Reviewed plugin operation" class="space-y-3 rounded-md border p-3 text-sm">
      <div>
        <h3 class="font-semibold">{labels[operation.state]}</h3>
        <p class="text-muted-foreground">{operation.action === "enable" ? "Enable" : "Disable"} {operation.profile}{plan ? ` ${plan.version}` : ""} · {operation.stationKey}</p>
      </div>
      {#if operation.inFlight}<p role="status">The hub is processing this operation. Inspect again for its latest outcome.</p>{/if}
      {#if plan?.refusal}
        <p class="text-destructive">The node will not {operation.action} the plugin: {plan.refusal}</p>
      {:else if operation.error}
        <p class="text-destructive">{operation.error}</p>
      {/if}
      {#if operation.state === "unknown"}<p>Completion is unconfirmed. Inspect the node's record before deciding whether to retry.</p>{/if}
      {#if operation.state === "conflict" && !plan?.refusal}<p>Nothing was changed. Plan again to review the profile as it is now.</p>{/if}
      {#if plan}
        {#if plan.gate}
          <p>Hermes {plan.gate.version ?? "version unknown"}: {plan.gate.allowed ? "tested" : "not allowed"} — {plan.gate.reason}</p>
        {/if}
        {#if plan.fileAction}
          <p>{fileActions[plan.fileAction]}{plan.fileNames.length ? `: ${plan.fileNames.join(", ")}` : ""}.</p>
        {/if}
        {#each plan.notes as note}<p class="text-muted-foreground">{note}</p>{/each}
        {#if plan.noOp}
          <p>Nothing to change: this version is installed and enabled.</p>
        {:else if plan.config}
          {#if plan.config.beforeSHA256 === plan.config.afterSHA256}
            <p>config.yaml is unchanged.</p>
          {:else}
            <div>
              <p>{plan.config.restoresBackup ? "config.yaml is restored from the backup taken at enable:" : "config.yaml changes:"}</p>
              <pre aria-label="Configuration change" class="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs">{plan.config.diff}</pre>
              {#if plan.config.diffTruncated}<p class="text-xs text-muted-foreground">The change is longer than shown.</p>{/if}
              {#if operation.action === "enable" && !plan.config.restoresBackup}<p class="text-xs text-muted-foreground">The current file is backed up beside it first.</p>{/if}
            </div>
          {/if}
        {/if}
        <details>
          <summary class="cursor-pointer">Review identifiers</summary>
          <dl class="mt-2 space-y-1 break-all font-mono text-xs">
            <div><dt>Operation</dt><dd>{operation.id}</dd></div>
            <div><dt>Reviewed plan</dt><dd>{plan.planDigest}</dd></div>
            {#if plan.config}<div><dt>config.yaml before → after</dt><dd>{plan.config.beforeSHA256.slice(0, 16)} → {plan.config.afterSHA256.slice(0, 16)}</dd></div>{/if}
          </dl>
        </details>
      {/if}
      {#if operation.state === "applied" && plan?.restartRequired}
        <div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <p>Hermes reads plugins when its gateway starts. Nothing was restarted; restart the station to {operation.action === "enable" ? "load" : "unload"} the plugin, then refresh the skill inventory to see what the gateway reports.</p>
          {#if onRestart}<Button size="sm" variant="outline" class="mt-2" onclick={onRestart}>Restart station…</Button>{/if}
        </div>
      {/if}
      <div class="flex flex-wrap gap-2">
        {#if operation.state === "planned" && plan && !plan.noOp && !operation.inFlight}
          <Button size="sm" disabled={locked} onclick={apply}>Apply reviewed plan</Button>
        {/if}
        <Button size="sm" variant="outline" disabled={busy !== null} onclick={inspect}>Inspect node record</Button>
      </div>
    </section>
  {/if}
  <section aria-label="Plugin operation history" class="space-y-2 text-sm">
    <h3 class="font-medium">Recent plugin operations</h3>
    {#if history.length === 0}<p class="text-muted-foreground">No recorded plugin operations.</p>{/if}
    <ul class="space-y-2">
      {#each history as item (item.id)}
        <li class="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
          <div><p>{item.profile} · {item.action} · {labels[item.state]}</p><p class="text-xs text-muted-foreground">{item.createdAt}</p></div>
          <Button size="sm" variant="outline" disabled={busy !== null} onclick={() => open(item)}>Open operation</Button>
        </li>
      {/each}
    </ul>
  </section>
</section>
