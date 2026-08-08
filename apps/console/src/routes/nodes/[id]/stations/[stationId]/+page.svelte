<script lang="ts">
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import { page } from "$app/stores";
  import HealthPanel from "$lib/components/stations/HealthPanel.svelte";
  import LogTail from "$lib/components/stations/LogTail.svelte";
  import FileBrowser from "$lib/components/stations/FileBrowser.svelte";
  import ConfigEditor from "$lib/components/stations/ConfigEditor.svelte";
  import Terminal from "$lib/components/stations/Terminal.svelte";
  import CleanupPanel from "$lib/components/stations/CleanupPanel.svelte";
  import ActivityPanel from "$lib/components/stations/ActivityPanel.svelte";
  import { listStations } from "$lib/api/client";
  import type { StationRow } from "$lib/api/client";
  import PageHeader from "$lib/components/page-header.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import * as Dialog from "$lib/components/ui/dialog";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import HeartPulseIcon from "@lucide/svelte/icons/heart-pulse";
  import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ActivityIcon from "@lucide/svelte/icons/activity";

  const nodeId = $derived($page.params.id as string);
  const stationId = $derived($page.params.stationId as string);

  type Tab = "health" | "logs" | "files" | "terminal" | "cleanup" | "activity";
  let activeTab = $state<Tab>("health");

  /** Tabs the user has switched to at least once — kept mounted after that
   *  so logs/files/terminal panels don't lose their SSE stream, tree state,
   *  or scrollback when the user tabs away and back. */
  let visited = $state(new Set<Tab>(["health"]));
  $effect(() => {
    if (!visited.has(activeTab)) visited = new Set(visited).add(activeTab);
  });

  let station = $state<StationRow | null>(null);

  /** Path of the file currently open in the ConfigEditor modal, or null. */
  let configEditorPath = $state<string | null>(null);

  const hasTerminal = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("terminal")
  );

  const canWrite = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("fs.write")
  );

  const canLifecycle = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("lifecycle")
  );

  const hasCleanup = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("cleanup")
  );

  onMount(async () => {
    try {
      const rows = await listStations(nodeId);
      station = rows.find((r) => r.id === stationId) ?? null;
    } catch {
      // Capabilities will stay null — Terminal tab won't appear
    }
  });

  const tabs = $derived.by(() => [
    { id: "health", label: "Health", icon: HeartPulseIcon },
    { id: "logs", label: "Logs", icon: ScrollTextIcon },
    { id: "files", label: "Files", icon: FolderIcon },
    ...(hasTerminal ? [{ id: "terminal", label: "Terminal", icon: TerminalIcon }] : []),
    ...(hasCleanup ? [{ id: "cleanup", label: "Cleanup", icon: Trash2Icon }] : []),
    { id: "activity", label: "Activity", icon: ActivityIcon },
  ]);

  function handleTabChange(tabId: string) {
    activeTab = tabId as Tab;
  }
</script>

{#snippet panel(id: Tab, content: Snippet)}
  {#if visited.has(id)}
    <div
      role="tabpanel"
      id="page-tabs-panel-{id}"
      aria-labelledby="page-tabs-tab-{id}"
      class={activeTab === id ? "contents" : "hidden"}
    >
      {@render content()}
    </div>
  {/if}
{/snippet}

<!-- Themed header: station name, harness badge, back link, and tab bar -->
<PageHeader
  title={station?.displayName ?? stationId}
  subtitle={station?.workspacePath ?? undefined}
  {tabs}
  activeTab={activeTab}
  onTabChange={handleTabChange}
  sticky={true}
>
  {#snippet leading()}
    <Button
      variant="ghost"
      size="icon"
      href="/nodes/{nodeId}"
      class="h-8 w-8 border border-border/30 hover:border-primary hover:text-primary"
    >
      <ArrowLeftIcon class="h-4 w-4" />
    </Button>
    {#if station?.harness}
      <Badge variant="outline" class="font-mono text-xs uppercase tracking-wider shrink-0">
        {station.harness}
      </Badge>
    {/if}
  {/snippet}
</PageHeader>

<!-- Panel content -->
<div class="container mx-auto flex max-w-7xl flex-1 flex-col px-4 py-4 sm:px-6 md:py-6 min-h-0">
  {@render panel("health", healthContent)}
  {#snippet healthContent()}
    <HealthPanel {stationId} {canLifecycle} matrixId={station?.matrixId ?? null} />
  {/snippet}

  {@render panel("logs", logsContent)}
  {#snippet logsContent()}
    <div class="flex-1 min-h-[320px]">
      <LogTail {stationId} />
    </div>
  {/snippet}

  {@render panel("files", filesContent)}
  {#snippet filesContent()}
    <div class="flex-1 min-h-[320px]">
      <FileBrowser
        {stationId}
        {canWrite}
        onOpenConfigEditor={canWrite ? (p) => (configEditorPath = p) : undefined}
      />
    </div>
  {/snippet}

  {#if hasTerminal}
    {@render panel("terminal", terminalContent)}
    {#snippet terminalContent()}
      <div class="flex-1 min-h-[320px]">
        <Terminal {stationId} />
      </div>
    {/snippet}
  {/if}

  {#if hasCleanup}
    {@render panel("cleanup", cleanupContent)}
    {#snippet cleanupContent()}
      <div class="min-h-[200px]">
        <CleanupPanel {stationId} />
      </div>
    {/snippet}
  {/if}

  {@render panel("activity", activityContent)}
  {#snippet activityContent()}
    <div class="min-h-[200px]">
      <ActivityPanel {stationId} />
    </div>
  {/snippet}
</div>

<!-- ── ConfigEditor dialog (opened via "Edit (diff)" in the FileBrowser) ── -->
<Dialog.Root
  open={configEditorPath !== null && canWrite}
  onOpenChange={(open) => {
    if (!open) configEditorPath = null;
  }}
>
  <Dialog.Content class="flex h-[80vh] max-w-4xl flex-col overflow-hidden p-0" showCloseButton={false}>
    {#if configEditorPath !== null && canWrite}
      <ConfigEditor
        {stationId}
        path={configEditorPath}
        onClose={() => (configEditorPath = null)}
      />
    {/if}
  </Dialog.Content>
</Dialog.Root>
