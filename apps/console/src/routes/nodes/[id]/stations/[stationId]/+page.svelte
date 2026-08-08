<script lang="ts">
  import { onMount } from "svelte";
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
<div class="container mx-auto px-4 sm:px-6 py-4 md:py-6 max-w-7xl">
  {#if activeTab === "health"}
    <HealthPanel {stationId} {canLifecycle} matrixId={station?.matrixId ?? null} />
  {:else if activeTab === "logs"}
    <div class="h-[480px]">
      <LogTail {stationId} />
    </div>
  {:else if activeTab === "files"}
    <div class="h-[480px]">
      <FileBrowser
        {stationId}
        {canWrite}
        onOpenConfigEditor={canWrite ? (p) => (configEditorPath = p) : undefined}
      />
    </div>
  {:else if activeTab === "terminal" && hasTerminal}
    <div class="h-[480px]">
      <Terminal {stationId} />
    </div>
  {:else if activeTab === "cleanup" && hasCleanup}
    <div class="min-h-[200px]">
      <CleanupPanel {stationId} />
    </div>
  {:else if activeTab === "activity"}
    <div class="min-h-[200px]">
      <ActivityPanel {stationId} />
    </div>
  {/if}
</div>

<!-- ── ConfigEditor modal (opened via "Edit (diff)" in the FileBrowser) ── -->
{#if configEditorPath !== null && canWrite}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
    role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget) configEditorPath = null; }}
    onkeydown={(e) => { if (e.key === "Escape") configEditorPath = null; }}
  >
    <div class="relative z-10 w-full max-w-4xl h-[80vh] flex flex-col rounded-lg border border-border shadow-lg overflow-hidden">
      <ConfigEditor
        {stationId}
        path={configEditorPath}
        onClose={() => (configEditorPath = null)}
      />
    </div>
  </div>
{/if}
