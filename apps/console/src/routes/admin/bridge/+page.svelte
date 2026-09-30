<script lang="ts">
  /**
   * The superpipeline bridge's roster — which agents claim from which board, onto which station.
   *
   * This page is the whole point of moving the roster out of `hub.env`. It used to be a JSON array
   * in an environment file, so adding an agent or rotating a credential meant root on the hub host
   * and a restart; a control that awkward is one people route around, which is the same argument
   * the Grants page next to it makes.
   *
   * **Two things it must never do.** It must not pretend to show a credential: the hub stores them
   * encrypted and answers only whether one is set, so this offers "replace" and never "reveal" —
   * a masked field that showed something would be a lie about what is knowable. And it must not
   * offer a free-text station id: the database refuses a station that does not exist, and a picker
   * makes that refusal unreachable rather than merely survivable.
   *
   * A change here takes effect within one reconcile tick (10s) — no restart. That is what the
   * "takes effect within a few seconds" note under the form is telling an operator, because the
   * old behaviour trained everyone to expect otherwise.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import AdminTabs from "$lib/components/admin/AdminTabs.svelte";
  import PageHeader from "$lib/components/page-header.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Empty } from "$lib/components/ui/empty";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { getFleet } from "$lib/api/client";
  import {
    createBridgeAgent,
    deleteBridgeAgent,
    listBridgeAgents,
    updateBridgeAgent,
    type BridgeAgent,
  } from "$lib/api/bridge-agents";

  let agents = $state<BridgeAgent[]>([]);
  let stations = $state<Array<{ id: string; displayName: string; harness: string }>>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let confirming = $state<BridgeAgent | null>(null);

  // ─── the add form ──────────────────────────────────────────────────────────
  let showForm = $state(false);
  let fKey = $state("");
  let fBoardId = $state("");
  let fStationId = $state("");
  let fToken = $state("");
  let fMcpToken = $state("");
  let fMode = $state<BridgeAgent["mode"]>("accept-edits");

  const canSubmit = $derived(
    fKey.trim() !== "" && fBoardId.trim() !== "" && fStationId !== "" && fToken.trim() !== "",
  );

  async function refresh(): Promise<void> {
    try {
      agents = await listBridgeAgents();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    await refresh();
    try {
      // The fleet view is every adopted station across every node — which is exactly the set a
      // roster entry may name. `listStations` is per node and would need the node list first.
      stations = (await getFleet()).agents.map((s) => ({
        id: s.stationId,
        displayName: s.agentName,
        harness: s.harness,
      }));
    } catch {
      // A station list that will not load costs the picker, not the page: the ids already on the
      // roster still render, and the form says why it cannot offer choices.
      stations = [];
    }
  });

  function resetForm(): void {
    fKey = fBoardId = fStationId = fToken = fMcpToken = "";
    fMode = "accept-edits";
    showForm = false;
  }

  async function onCreate(): Promise<void> {
    if (!canSubmit) return;
    saving = true;
    try {
      await createBridgeAgent({
        key: fKey.trim(),
        boardId: fBoardId.trim(),
        stationId: fStationId,
        token: fToken.trim(),
        mcpToken: fMcpToken.trim() || null,
        mode: fMode,
      });
      toast.success(`${fKey.trim()} added — it starts claiming within a few seconds.`);
      resetForm();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      saving = false;
    }
  }

  async function onToggle(a: BridgeAgent): Promise<void> {
    try {
      await updateBridgeAgent(a.key, { enabled: !a.enabled });
      toast.success(
        a.enabled
          ? `${a.key} disabled — it finishes the card it is holding, then stops.`
          : `${a.key} enabled.`,
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onRotate(a: BridgeAgent, which: "token" | "mcpToken"): Promise<void> {
    const label = which === "token" ? "claim credential" : "run-only credential";
    const next = prompt(`New ${label} for ${a.key} (spa_…):`);
    if (!next) return;
    try {
      await updateBridgeAgent(a.key, { [which]: next.trim() });
      toast.success(`${a.key}: ${label} replaced.`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete(a: BridgeAgent): Promise<void> {
    try {
      await deleteBridgeAgent(a.key);
      toast.success(`${a.key} removed.`);
      confirming = null;
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const stationLabel = (a: BridgeAgent) => a.stationName ?? a.stationId;
</script>

<svelte:head>
  <title>Bridge · Admin · AgentPod</title>
</svelte:head>

<PageHeader title="Admin" />

<div class="container mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
  <AdminTabs active="bridge" />

  <div class="flex items-start justify-between gap-4">
    <p class="text-muted-foreground max-w-2xl text-sm leading-relaxed">
      Which agents claim work from a superpipeline board, and where that work runs. Changes take
      effect within a few seconds — the hub does not need restarting.
    </p>
    <Button onclick={() => (showForm = !showForm)} disabled={loading}>
      {showForm ? "Cancel" : "Add an agent"}
    </Button>
  </div>

  {#if showForm}
    <div class="bg-muted/30 space-y-4 rounded-lg border p-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="space-y-1.5 text-sm">
          <span class="font-medium">Name</span>
          <input
            bind:value={fKey}
            placeholder="coder-kai"
            class="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          />
          <span class="text-muted-foreground block text-xs">
            Appears in the ledger and every log line, so it must be unique.
          </span>
        </label>

        <label class="space-y-1.5 text-sm">
          <span class="font-medium">Board</span>
          <input
            bind:value={fBoardId}
            placeholder="brd_6a899b0f0d054046"
            class="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm"
          />
        </label>

        <label class="space-y-1.5 text-sm">
          <span class="font-medium">Station</span>
          {#if stations.length > 0}
            <select
              bind:value={fStationId}
              class="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            >
              <option value="" disabled>Choose a station…</option>
              {#each stations as s (s.id)}
                <option value={s.id}>{s.displayName} · {s.harness}</option>
              {/each}
            </select>
          {:else}
            <input
              bind:value={fStationId}
              placeholder="station_…"
              class="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm"
            />
            <span class="text-muted-foreground block text-xs">
              No stations could be listed, so this is a plain field. The hub still refuses one that
              does not exist.
            </span>
          {/if}
        </label>

        <label class="space-y-1.5 text-sm">
          <span class="font-medium">Permission mode</span>
          <select
            bind:value={fMode}
            class="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="full-auto">full-auto — never asks</option>
            <option value="accept-edits">accept-edits — auto-approves edits in the workspace</option>
            <option value="ask">ask — asks before an edit</option>
          </select>
        </label>

        <p class="text-muted-foreground sm:col-span-2 text-xs leading-relaxed">
          <!--
            Written because the previous text here said accept-edits "asks before anything that
            executes", which is what the hub implements and what no harness delivers: across every
            session this fleet has run, 254 `execute` tool calls produced zero permission requests.
            A mode picker that implies supervision nobody provides is worse than one that says
            nothing.
          -->
          <strong>The mode controls edits, not commands.</strong> No harness currently asks before
          running one, so an agent you dispatch can execute on its station unasked whatever you pick
          here. Supervising execution needs it enforced where the process runs.
        </p>

        <label class="space-y-1.5 text-sm">
          <span class="font-medium">Claim credential</span>
          <input
            bind:value={fToken}
            type="password"
            placeholder="spa_…"
            class="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm"
          />
          <span class="text-muted-foreground block text-xs">
            Stored encrypted. It cannot be read back — only replaced.
          </span>
        </label>

        <label class="space-y-1.5 text-sm">
          <span class="font-medium">Run-only credential <span class="text-muted-foreground font-normal">(optional)</span></span>
          <input
            bind:value={fMcpToken}
            type="password"
            placeholder="spa_…"
            class="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm"
          />
          <span class="text-muted-foreground block text-xs">
            Lets the agent complete or block its own card. Mint it in superpipeline with
            <strong>Issue a run-only token</strong> — not the claim credential above, which could
            take a second card while working the first.
          </span>
        </label>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={resetForm}>Cancel</Button>
        <Button onclick={onCreate} disabled={!canSubmit || saving}>
          {saving ? "Adding…" : "Add"}
        </Button>
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="space-y-2">
      <Skeleton class="h-16 w-full" />
      <Skeleton class="h-16 w-full" />
    </div>
  {:else if error}
    <Empty title="Couldn’t load the roster" description={error} />
  {:else if agents.length === 0}
    <Empty
      title="No agents are rostered"
      description="The bridge is claiming nothing. Add an agent to start."
    />
  {:else}
    <div class="space-y-2">
      {#each agents as a (a.key)}
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
          <div class="min-w-0 space-y-1">
            <div class="flex items-center gap-2">
              <span class="font-medium">{a.key}</span>
              {#if !a.enabled}<Badge variant="outline">disabled</Badge>{/if}
              <Badge variant="secondary">{a.mode}</Badge>
              {#if a.hasMcpToken}
                <Badge variant="outline" title="Can complete or block its own card over MCP">
                  reports for itself
                </Badge>
              {/if}
            </div>
            <p class="text-muted-foreground text-xs">
              <span class="font-mono">{a.boardId}</span> → {stationLabel(a)}
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onclick={() => onRotate(a, "token")}>
              Replace claim token
            </Button>
            <Button variant="outline" size="sm" onclick={() => onRotate(a, "mcpToken")}>
              {a.hasMcpToken ? "Replace run-only token" : "Add run-only token"}
            </Button>
            <Button variant="outline" size="sm" onclick={() => onToggle(a)}>
              {a.enabled ? "Disable" : "Enable"}
            </Button>
            <Button variant="outline" size="sm" onclick={() => (confirming = a)}>Remove</Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirming !== null}
  title="Remove {confirming?.key}?"
  message="Its credentials are deleted with it. The card it is holding, if any, is finished first."
  confirmLabel="Remove agent"
  destructive
  onConfirm={() => confirming && onDelete(confirming)}
  onCancel={() => (confirming = null)}
/>
