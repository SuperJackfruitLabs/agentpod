<script lang="ts">
  import { changesetStatus, changesetDiff } from "$lib/api/client";
  import type {
    ChangesetStatusResult,
    ChangesetDiffResult,
    ChangesetFile,
  } from "$lib/api/client";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Empty } from "$lib/components/ui/empty";
  import CodeBlock from "$lib/components/ui/code-block/code-block.svelte";

  interface Props {
    stationId: string;
  }

  let { stationId }: Props = $props();

  type Side = "uncommitted" | "committed";

  // ─── State ────────────────────────────────────────────────────────────────────

  let status = $state<ChangesetStatusResult | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let openPath = $state<string | null>(null);
  let patch = $state<ChangesetDiffResult | null>(null);
  let patchLoading = $state(false);
  let patchError = $state<string | null>(null);

  // ─── Derived ──────────────────────────────────────────────────────────────────

  const isClean = $derived(
    !!status &&
      status.uncommitted.files.length === 0 &&
      status.committed.files.length === 0
  );

  /** Why this base, in words. A surprising diff on a machine you are not
   *  sitting at is otherwise unexplainable. */
  const baseExplanation = $derived.by(() => {
    switch (status?.base.reason) {
      case "explicit":
        return "you asked for this base";
      case "upstream":
        return "upstream — this branch tracks it";
      case "default-branch":
        return "default branch — this branch tracks nothing";
      case "head":
        return "HEAD — no upstream and no origin, so only uncommitted work is shown";
      default:
        return "";
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /** Empty for untracked and binary files: git gives no honest number for
   *  either, and "+0 −0" would read as "nothing in this file". */
  function counts(f: ChangesetFile): string {
    if (f.binary) return "binary";
    if (f.insertions === null || f.deletions === null) return "";
    return `+${f.insertions} −${f.deletions}`;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────────

  async function load() {
    loading = true;
    loadError = null;
    try {
      status = await changesetStatus(stationId);
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn't read this workspace.";
    } finally {
      loading = false;
    }
  }

  async function openFile(side: Side, file: ChangesetFile) {
    openPath = file.path;
    patch = null;
    patchError = null;
    patchLoading = true;
    try {
      patch = await changesetDiff(stationId, side, file.path);
    } catch (e) {
      // Deliberately does NOT clear `status`: the file list is still valid, and
      // blanking it would make a failed patch look like a broken panel.
      patchError = e instanceof Error ? e.message : "Couldn't read this file's diff.";
    } finally {
      patchLoading = false;
    }
  }

  $effect(() => {
    void stationId;
    load();
  });
</script>

{#snippet fileList(side: Side, files: ChangesetFile[])}
  {#each files as f (f.path)}
    <button
      type="button"
      data-testid="changeset-file-{f.path}"
      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted/60"
      onclick={() => openFile(side, f)}
    >
      <Badge variant="outline" class="shrink-0">{f.status}</Badge>
      <span class="truncate font-mono">{f.path}</span>
      {#if f.oldPath}
        <span class="text-muted-foreground shrink-0 truncate text-xs">was {f.oldPath}</span>
      {/if}
      <span class="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
        {counts(f)}
      </span>
    </button>
  {/each}
{/snippet}

<div class="flex flex-col gap-4">
  {#if loading}
    <p class="text-muted-foreground text-sm">Reading the workspace…</p>
  {:else if loadError}
    <Empty title="Couldn't read this workspace" description={loadError} />
  {:else if status}
    <Card.Root>
      <Card.Header>
        <Card.Title>
          {status.repo.detached ? "detached HEAD" : (status.repo.branch ?? "unknown branch")}
        </Card.Title>
        <Card.Description>
          Compared against <code class="font-mono">{status.base.ref}</code> — {baseExplanation}
        </Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button variant="outline" size="sm" onclick={load}>Refresh</Button>
      </Card.Footer>
    </Card.Root>

    {#if status.truncatedFiles}
      <p class="text-sm text-amber-600 dark:text-amber-500">
        Too many changed files to list them all — this is a partial view.
      </p>
    {/if}

    {#if isClean}
      <Empty
        title="No changes"
        description="This workspace matches its base. Nothing is uncommitted and nothing is waiting to be delivered."
      />
    {:else}
      {#if status.uncommitted.files.length > 0}
        <Card.Root>
          <Card.Header>
            <Card.Title>Uncommitted</Card.Title>
            <Card.Description>
              Not saved to a commit — the agent may still be working.
              <span class="tabular-nums">
                +{status.uncommitted.insertions} −{status.uncommitted.deletions}
              </span>
            </Card.Description>
          </Card.Header>
          <Card.Content class="flex flex-col gap-1">
            {@render fileList("uncommitted", status.uncommitted.files)}
          </Card.Content>
        </Card.Root>
      {/if}

      {#if status.committed.files.length > 0}
        <Card.Root>
          <Card.Header>
            <Card.Title>Committed, not on the base</Card.Title>
            <Card.Description>
              Finished work sitting on this machine.
              <span class="tabular-nums">
                +{status.committed.insertions} −{status.committed.deletions}
              </span>
            </Card.Description>
          </Card.Header>
          <Card.Content class="flex flex-col gap-1">
            {#each status.committed.commits as c (c.sha)}
              <p class="text-muted-foreground px-2 text-xs">
                <code class="font-mono">{c.shortSha}</code>
                {c.subject} — {c.author}
              </p>
            {/each}
            {@render fileList("committed", status.committed.files)}
          </Card.Content>
        </Card.Root>
      {/if}
    {/if}

    {#if openPath}
      <Card.Root>
        <Card.Header>
          <Card.Title class="font-mono text-sm">{openPath}</Card.Title>
          {#if patch?.truncated}
            <Card.Description>
              This patch is truncated — it was too large to send in full.
            </Card.Description>
          {/if}
        </Card.Header>
        <Card.Content>
          {#if patchLoading}
            <p class="text-muted-foreground text-sm">Loading the diff…</p>
          {:else if patchError}
            <p class="text-destructive text-sm">{patchError}</p>
          {:else if patch}
            {#if patch.binary || patch.content.trim() === ""}
              <p class="text-muted-foreground text-sm">
                No textual diff to show for this file.
              </p>
            {:else}
              <CodeBlock code={patch.content} language="diff" />
            {/if}
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}
  {/if}
</div>
