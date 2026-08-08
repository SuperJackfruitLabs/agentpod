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
  import HarnessBadge from "$lib/components/fleet/HarnessBadge.svelte";
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

  /** Base id PageHeader builds its tab/panel ids from — kept in one place so
   *  the tablist's aria-controls and the tabpanels' ids/aria-labelledby
   *  can't drift apart. */
  const tabsId = "page-tabs";

  /** Heavy tabs (SSE stream / file tree / terminal session) the user has
   *  switched to at least once — kept mounted after that so tab switches no
   *  longer drop the log stream, tree state, or terminal scrollback. Health/
   *  cleanup/activity intentionally stay plain if-mounted below: they fetch
   *  fresh data on every mount (e.g. Activity's onMount fetch), and keeping
   *  them alive would make that data go stale while the tab is hidden. */
  let visitedHeavyTabs = $state(new Set<Tab>());
  $effect(() => {
    if (
      (activeTab === "logs" || activeTab === "files" || activeTab === "terminal") &&
      !visitedHeavyTabs.has(activeTab)
    ) {
      visitedHeavyTabs = new Set(visitedHeavyTabs).add(activeTab);
    }
  });

  let station = $state<StationRow | null>(null);

  /** Path of the file currently open in the ConfigEditor modal, or null. */
  let configEditorPath = $state<string | null>(null);

  /** Instance ref so ConfigEditor's onSaved can evict FileBrowser's stale
   *  content cache for the saved path (see FileBrowser.invalidate). */
  let fileBrowser: FileBrowser | undefined = $state();

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

{#snippet keepAlivePanel(id: Tab, content: Snippet)}
  {#if visitedHeavyTabs.has(id)}
    <div
      role="tabpanel"
      id="{tabsId}-panel-{id}"
      aria-labelledby="{tabsId}-tab-{id}"
      class={activeTab === id ? "contents" : "hidden"}
    >
      {@render content()}
    </div>
  {/if}
{/snippet}

{#snippet mountedPanel(id: Tab, content: Snippet)}
  {#if activeTab === id}
    <div role="tabpanel" id="{tabsId}-panel-{id}" aria-labelledby="{tabsId}-tab-{id}">
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
  {tabsId}
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
      <HarnessBadge harness={station.harness} class="shrink-0" />
    {/if}
  {/snippet}
</PageHeader>

<!-- Panel content -->
<div class="container mx-auto flex max-w-7xl flex-1 flex-col px-4 py-4 sm:px-6 md:py-6 min-h-0">
  {@render mountedPanel("health", healthContent)}
  {#snippet healthContent()}
    <HealthPanel {stationId} {canLifecycle} matrixId={station?.matrixId ?? null} />
  {/snippet}

  {@render keepAlivePanel("logs", logsContent)}
  {#snippet logsContent()}
    <div class="flex-1 min-h-[320px]">
      <LogTail {stationId} />
    </div>
  {/snippet}

  {@render keepAlivePanel("files", filesContent)}
  {#snippet filesContent()}
    <div class="flex-1 min-h-[320px]">
      <FileBrowser
        bind:this={fileBrowser}
        {stationId}
        {canWrite}
        onOpenConfigEditor={canWrite ? (p) => (configEditorPath = p) : undefined}
      />
    </div>
  {/snippet}

  {#if hasTerminal}
    {@render keepAlivePanel("terminal", terminalContent)}
    {#snippet terminalContent()}
      <div class="flex-1 min-h-[320px]">
        <Terminal {stationId} />
      </div>
    {/snippet}
  {/if}

  {#if hasCleanup}
    {@render mountedPanel("cleanup", cleanupContent)}
    {#snippet cleanupContent()}
      <div class="min-h-[200px]">
        <CleanupPanel {stationId} />
      </div>
    {/snippet}
  {/if}

  {@render mountedPanel("activity", activityContent)}
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
  <Dialog.Content
    class="flex h-[80vh] max-w-4xl sm:max-w-4xl flex-col overflow-hidden p-0"
    showCloseButton={false}
  >
    {#if configEditorPath !== null && canWrite}
      <ConfigEditor
        {stationId}
        path={configEditorPath}
        onClose={() => (configEditorPath = null)}
        onSaved={(p) => fileBrowser?.invalidate(p)}
      />
    {/if}
  </Dialog.Content>
</Dialog.Root>
