<script lang="ts">
  import * as api from "$lib/api/timeline";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Empty } from "$lib/components/ui/empty";
  import { DiffLines } from "$lib/components/ui/diff-lines";
  import * as Dialog from "$lib/components/ui/dialog";

  // Item 11a: a Salaam station's board runs, each completed step's checkpoint, and what restoring
  // one would do to each file. Read-only: restoring is a separate, approved operation.
  // `canRestore`: the viewer is a workspace owner or admin. Restore is only for an ended run.
  let { stationId, canRestore = false }: { stationId: string; canRestore?: boolean } = $props();
  let confirming = $state(false);
  let restoring = $state(false);
  let restored = $state<string | null>(null);

  let runs = $state<api.TimelineRun[] | null>(null);
  let run = $state<api.TimelineRun | null>(null);
  let checkpoints = $state<api.Checkpoint[] | null>(null);
  let open = $state<string | null>(null);
  let diff = $state<api.CheckpointDiff | null>(null);
  let error = $state<string | null>(null);
  const ended = $derived(run?.state === "revoked" && run?.status === "ended");
  let epoch = 0;

  const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

  async function choose(next: api.TimelineRun, ticket: number) {
    run = next;
    checkpoints = null;
    open = null;
    diff = null;
    try {
      const list = await api.listCheckpoints(stationId, next.sessionId);
      if (ticket === epoch) checkpoints = list;
    } catch (e) {
      if (ticket === epoch) error = message(e, "Could not read the checkpoints");
    }
  }

  $effect(() => {
    const ticket = ++epoch;
    runs = null;
    error = null;
    void api
      .listTimelineRuns(stationId)
      .then((list) => {
        if (ticket !== epoch) return;
        runs = list;
        if (list[0]) void choose(list[0], ticket);
      })
      .catch((e) => {
        if (ticket === epoch) error = message(e, "Could not read this station's runs");
      });
    return () => {
      epoch++;
    };
  });

  async function show(checkpoint: api.Checkpoint) {
    if (!run) return;
    open = checkpoint.id;
    diff = null;
    const ticket = epoch;
    try {
      const result = await api.checkpointDiff(stationId, run.sessionId, checkpoint.id);
      if (ticket === epoch && open === checkpoint.id) diff = result;
    } catch (e) {
      if (ticket === epoch) error = message(e, "Could not read this checkpoint");
    }
  }

  const label: Record<api.CheckpointFile["change"], string> = {
    revert: "Revert",
    delete: "Delete (added later)",
    bring_back: "Bring back (deleted later)",
    unchanged: "Unchanged",
    not_restorable: "Can't restore (existed before this run)",
  };
  const contentAt = (f: api.CheckpointFile) => (f.at_checkpoint.state === "content" ? f.at_checkpoint.content : "");

  async function restore() {
    if (!run || !diff || !canRestore || !ended) return;
    restoring = true;
    error = null;
    try {
      await api.restoreCheckpoint(stationId, run.sessionId, diff.checkpoint.id, diff.restore_digest);
      restored = diff.checkpoint.id;
      confirming = false;
    } catch (e) {
      error = message(e, "Could not restore this checkpoint");
    } finally {
      restoring = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  {#if error}
    <Empty title="Couldn't read the timeline" description={error} />
  {:else if runs === null}
    <p class="text-muted-foreground text-sm">Reading this station's runs…</p>
  {:else if runs.length === 0}
    <Empty
      title="No board runs yet"
      description="Checkpoints appear here once a board run on this station completes a step."
    />
  {:else}
    <Card.Root class="ap-panel">
      <Card.Header>
        <Card.Title>Run {run?.runId}</Card.Title>
        <Card.Description>
          One checkpoint after each completed step. Files only: the conversation is not part of a
          checkpoint, and changes made only by shell commands are not tracked.
        </Card.Description>
      </Card.Header>
      {#if runs.length > 1}
        <Card.Footer class="flex flex-wrap gap-2">
          {#each runs as r (r.sessionId)}
            <Button
              variant={r.sessionId === run?.sessionId ? "default" : "outline"}
              size="sm"
              onclick={() => choose(r, epoch)}>{r.runId}</Button
            >
          {/each}
        </Card.Footer>
      {/if}
    </Card.Root>

    {#if checkpoints === null}
      <p class="text-muted-foreground text-sm">Reading checkpoints…</p>
    {:else if checkpoints.length === 0}
      <Empty title="No checkpoints yet" description="This run has not completed a step." />
    {:else}
      <div class="flex flex-col gap-2">
        {#each checkpoints as c (c.id)}
          <Card.Root class="ap-panel">
            <Card.Header>
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 text-left"
                aria-expanded={open === c.id}
                onclick={() => show(c)}
              >
                <span class="font-medium">After {c.step_key}</span>
                <span class="flex items-center gap-2">
                  <Badge variant="outline">{c.files_changed.length} {c.files_changed.length === 1 ? "file" : "files"}</Badge>
                  <code class="text-muted-foreground font-mono text-xs">{c.tree_digest.slice(0, 12)}</code>
                </span>
              </button>
            </Card.Header>
            {#if open === c.id}
              <Card.Content class="flex flex-col gap-3">
                {#if diff === null}
                  <p class="text-muted-foreground text-sm">Comparing with now…</p>
                {:else if diff.files.length === 0}
                  <p class="text-muted-foreground text-sm">Nothing was written after this checkpoint.</p>
                {:else}
                  <p class="text-muted-foreground text-sm">Restoring this checkpoint would change:</p>
                  {#if restored === c.id}
                    <p class="text-sm">Restored. The files are back as they were at this checkpoint; nothing re-runs.</p>
                  {:else if canRestore && ended}
                    <div>
                      <Button size="sm" onclick={() => (confirming = true)}>Restore files to here…</Button>
                    </div>
                  {:else if canRestore}
                    <p class="text-muted-foreground text-sm">Restore is available after the run has ended.</p>
                  {/if}
                  {#each diff.files as f (f.path)}
                    <div class="flex flex-col gap-1">
                      <div class="flex items-center justify-between gap-3">
                        <code class="font-mono text-sm">{f.path}</code>
                        <Badge variant={f.change === "not_restorable" ? "destructive" : "outline"}>{label[f.change]}</Badge>
                      </div>
                      {#if f.change !== "not_restorable" && f.change !== "unchanged"}
                        <div class="ap-diff-box"><DiffLines oldText={f.current ?? ""} newText={contentAt(f)} /></div>
                      {/if}
                    </div>
                  {/each}
                {/if}
              </Card.Content>
            {/if}
          </Card.Root>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if diff}
  <Dialog.Root open={confirming} onOpenChange={(v) => { if (!restoring) confirming = v; }}>
    <Dialog.Content>
      <Dialog.Header>
        <Dialog.Title>Restore files to after {diff.checkpoint.step_key}?</Dialog.Title>
        <Dialog.Description>
          Salaam writes these files back through the station, each with a receipt. Checks run after this
          checkpoint no longer count. Only files change: the conversation stays as it is, and nothing re-runs.
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2 text-sm">
        {#each diff.files as f (f.path)}
          <div class="flex items-center justify-between gap-3">
            <code class="font-mono">{f.path}</code>
            <span class="text-muted-foreground">{f.change === "not_restorable" ? "left as it is (existed before this run)" : label[f.change]}</span>
          </div>
        {/each}
        <p class="text-muted-foreground text-xs">
          Bound to checkpoint <code class="font-mono">{diff.checkpoint.tree_digest.slice(0, 12)}</code> and the current tree
          <code class="font-mono">{diff.current_tree.slice(0, 12)}</code>: if the files change first, this approval no longer applies.
        </p>
      </div>
      <Dialog.Footer>
        <Button variant="outline" disabled={restoring} onclick={() => (confirming = false)}>Cancel</Button>
        <Button variant="destructive" disabled={restoring} onclick={restore}>
          {restoring ? "Restoring…" : "Approve restore"}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
